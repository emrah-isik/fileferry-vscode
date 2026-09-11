import { mapEntries, ImportPrompts, MapperInput, MapResult } from '../../../../importers/vscodeSftp/mapper';
import { SftpJsonEntry } from '../../../../importers/vscodeSftp/parser';
import { ProjectConfig } from '../../../../models/ProjectConfig';
import { SshCredential } from '../../../../models/SshCredential';

// Feature 35b: entries → { config, credentials, report } per the plan's
// field-mapping table. Pure apart from the two injected prompts (Q13
// password, Q14 relative remotePath) — Esc (undefined) skips, never guesses.

function entry(raw: Record<string, unknown>, overrides: Partial<SftpJsonEntry> = {}): SftpJsonEntry {
  return { name: 'Prod', isDefault: true, raw, ...overrides };
}

interface Harness {
  result: MapResult;
  passwordPrompts: string[];
  rootPathPrompts: string[];
}

async function run(
  entries: SftpJsonEntry[],
  options: Partial<MapperInput> & { password?: string | undefined; rootPath?: string | undefined } = {}
): Promise<Harness> {
  const passwordPrompts: string[] = [];
  const rootPathPrompts: string[] = [];
  const prompts: ImportPrompts = {
    askPassword: async (target) => { passwordPrompts.push(target.credentialName); return options.password; },
    askRootPath: async (target) => { rootPathPrompts.push(`${target.name}:${target.relativePath}`); return options.rootPath; },
  };
  let counter = 0;
  const result = await mapEntries(
    {
      entries,
      parseNotices: options.parseNotices ?? [],
      existingConfig: options.existingConfig ?? null,
      existingCredentials: options.existingCredentials ?? [],
      ignoreFiles: options.ignoreFiles ?? {},
      generateId: () => `id-${++counter}`,
    },
    prompts
  );
  return { result, passwordPrompts, rootPathPrompts };
}

const basic = { host: 'prod.example.com', username: 'deploy', password: 'hunter2', remotePath: '/var/www' };

describe('mapEntries — a plain SFTP entry', () => {
  it('produces one server, one password credential, and the default server', async () => {
    const { result } = await run([entry(basic)]);
    expect(result.config).toEqual({
      defaultServerId: 'id-2',
      servers: {
        Prod: {
          id: 'id-2',
          type: 'sftp',
          credentialId: 'id-1',
          credentialName: 'Prod',
          rootPath: '/var/www',
          mappings: [{ localPath: '/', remotePath: '' }],
          excludedPaths: [],
        },
      },
    });
    expect(result.credentials).toEqual([{
      credential: { id: 'id-1', name: 'Prod', host: 'prod.example.com', port: 22, username: 'deploy', authMethod: 'password' },
      password: 'hunter2',
      passphrase: undefined,
    }]);
    expect(result.report.imported).toEqual([
      expect.objectContaining({ serverName: 'Prod', credentialName: 'Prod', type: 'sftp', isDefault: true, hopCredentialNames: [] }),
    ]);
    expect(result.report.plaintextPasswordsInSftpJson).toBe(true);
  });

  it('honours an explicit port', async () => {
    const { result } = await run([entry({ ...basic, port: 2222 })]);
    expect(result.credentials[0].credential.port).toBe(2222);
  });

  it('maps context to the mapping localPath', async () => {
    const { result } = await run([entry(basic, { context: './web/' })]);
    expect(result.config.servers.Prod.mappings).toEqual([{ localPath: '/web', remotePath: '' }]);
  });

  it('maps an absolute context to the workspace root with a note', async () => {
    const { result } = await run([entry(basic, { context: '/home/me/site' })]);
    expect(result.config.servers.Prod.mappings).toEqual([{ localPath: '/', remotePath: '' }]);
    expect(result.report.notes).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/absolute context/i) }));
  });

  it('skips an entry with no host', async () => {
    const { result } = await run([entry({ username: 'u', remotePath: '/x' })]);
    expect(result.config.servers).toEqual({});
    expect(result.report.skippedEntries).toEqual([{ entry: 'Prod', reason: expect.stringMatching(/no "host"/) }]);
  });

  it('skips an entry with no username', async () => {
    const { result } = await run([entry({ host: 'h', remotePath: '/x' })]);
    expect(result.report.skippedEntries).toEqual([{ entry: 'Prod', reason: expect.stringMatching(/no "username"/) }]);
  });

  it('skips an unsupported protocol', async () => {
    const { result } = await run([entry({ ...basic, protocol: 'local' })]);
    expect(result.report.skippedEntries).toEqual([{ entry: 'Prod', reason: expect.stringMatching(/protocol "local"/) }]);
  });

  it('forwards parse notices into skippedEntries', async () => {
    const { result } = await run([], { parseNotices: [{ entry: 'X', message: 'entry 2 is not an object and was skipped' }] });
    expect(result.report.skippedEntries).toEqual([{ entry: 'X', reason: 'entry 2 is not an object and was skipped' }]);
  });
});

describe('mapEntries — protocol variants', () => {
  it.each([
    [{ protocol: 'ftp' }, 'ftp', 21],
    [{ protocol: 'ftp', secure: true }, 'ftps', 21],
    [{ protocol: 'ftp', secure: 'control' }, 'ftps', 21],
    [{ protocol: 'ftp', secure: 'implicit' }, 'ftps-implicit', 21],
    [{ protocol: 'sftp' }, 'sftp', 22],
  ])('%p → type %s, default port %d', async (fields, type, port) => {
    const { result } = await run([entry({ ...basic, ...fields })]);
    expect(result.config.servers.Prod.type).toBe(type);
    expect(result.credentials[0].credential.port).toBe(port);
  });

  it('keeps FTP on password auth and reports a private key as unsupported there', async () => {
    const { result } = await run([entry({ ...basic, protocol: 'ftp', privateKeyPath: '~/.ssh/id_rsa' })]);
    expect(result.credentials[0].credential.authMethod).toBe('password');
    expect(result.credentials[0].credential.privateKeyPath).toBeUndefined();
    expect(result.report.unsupportedOptions).toEqual([{ entry: 'Prod', options: [expect.stringMatching(/^privateKeyPath/)] }]);
  });
});

describe('mapEntries — authentication', () => {
  it('key auth with a stored passphrase', async () => {
    const { result } = await run([entry({ ...basic, password: undefined, privateKeyPath: '~/.ssh/id_ed25519', passphrase: 'secret' })]);
    expect(result.credentials[0].credential).toMatchObject({ authMethod: 'key', privateKeyPath: '~/.ssh/id_ed25519' });
    expect(result.credentials[0].passphrase).toBe('secret');
    expect(result.credentials[0].password).toBeUndefined();
    expect(result.report.plaintextPasswordsInSftpJson).toBe(false);
  });

  it('passphrase:true → key auth, no stored passphrase, one report line', async () => {
    const { result, passwordPrompts } = await run([entry({ host: 'h', username: 'u', remotePath: '/', privateKeyPath: '/k', passphrase: true })]);
    expect(result.credentials[0].passphrase).toBeUndefined();
    expect(passwordPrompts).toEqual([]);
    expect(result.report.promptsSkipped).toEqual([{ entry: 'Prod', message: expect.stringMatching(/passphrase/i) }]);
  });

  it('notes a private key path that the credential panel would reject', async () => {
    const { result } = await run([entry({ host: 'h', username: 'u', remotePath: '/', privateKeyPath: 'C:\\keys\\id_rsa' })]);
    expect(result.credentials[0].credential.privateKeyPath).toBe('C:\\keys\\id_rsa');
    expect(result.report.notes).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/private key path/i) }));
  });

  it('agent auth passes the socket path (and "pageant") through', async () => {
    const { result } = await run([
      entry({ host: 'h', username: 'u', remotePath: '/', agent: '$SSH_AUTH_SOCK' }),
      entry({ host: 'h2', username: 'u', remotePath: '/', agent: 'pageant' }, { name: 'Win', isDefault: false }),
    ]);
    expect(result.credentials[0].credential).toMatchObject({ authMethod: 'agent', agentSocketPath: '$SSH_AUTH_SOCK' });
    expect(result.credentials[1].credential).toMatchObject({ authMethod: 'agent', agentSocketPath: 'pageant' });
  });

  it('interactiveAuth:true → keyboard-interactive; canned answers array → keyboard-interactive plus a note', async () => {
    const { result } = await run([
      entry({ host: 'h', username: 'u', remotePath: '/', interactiveAuth: true }),
      entry({ host: 'h2', username: 'u', remotePath: '/', interactiveAuth: ['1234'] }, { name: 'Canned', isDefault: false }),
    ]);
    expect(result.credentials[0].credential.authMethod).toBe('keyboard-interactive');
    expect(result.credentials[1].credential.authMethod).toBe('keyboard-interactive');
    expect(result.report.notes).toContainEqual({ entry: 'Canned', message: expect.stringMatching(/canned answers/i) });
  });

  it('a key wins over agent wins over interactiveAuth wins over password', async () => {
    const { result } = await run([entry({ host: 'h', username: 'u', remotePath: '/', privateKeyPath: '/k', agent: 'x', interactiveAuth: true, password: 'p' })]);
    expect(result.credentials[0].credential.authMethod).toBe('key');
    expect(result.credentials[0].password).toBeUndefined();
  });

  it('missing password → prompt; the answer goes to the keychain', async () => {
    const { result, passwordPrompts } = await run([entry({ host: 'h', username: 'u', remotePath: '/' })], { password: 'typed' });
    expect(passwordPrompts).toEqual(['Prod']);
    expect(result.credentials[0].password).toBe('typed');
    expect(result.report.promptsSkipped).toEqual([]);
  });

  it('missing password + Esc → credential saved without a password + report line', async () => {
    const { result } = await run([entry({ host: 'h', username: 'u', remotePath: '/' })], { password: undefined });
    expect(result.credentials[0].password).toBeUndefined();
    expect(result.config.servers.Prod).toBeDefined();
    expect(result.report.promptsSkipped).toEqual([{ entry: 'Prod', message: expect.stringMatching(/no password stored/i) }]);
  });
});

describe('mapEntries — remotePath (Q14)', () => {
  it.each(['./', '.', 'www', 'public_html/', '~/site', undefined])('relative %p → prompt for the absolute path', async (remotePath) => {
    const { result, rootPathPrompts } = await run([entry({ host: 'h', username: 'u', password: 'p', remotePath })], { rootPath: '/home/u/site' });
    expect(rootPathPrompts).toEqual([`Prod:${remotePath ?? './'}`]);
    expect(result.config.servers.Prod.rootPath).toBe('/home/u/site');
  });

  it('Esc on the path prompt skips that server only, never writing schema-invalid config', async () => {
    const { result, passwordPrompts } = await run([
      entry({ host: 'h', username: 'u', remotePath: './' }),
      entry({ ...basic }, { name: 'Other', isDefault: false }),
    ], { rootPath: undefined });
    expect(Object.keys(result.config.servers)).toEqual(['Other']);
    expect(result.credentials).toHaveLength(1);
    expect(passwordPrompts).toEqual([]);
    expect(result.report.skippedEntries).toEqual([{ entry: 'Prod', reason: expect.stringMatching(/relative remotePath "\.\/"/) }]);
  });

  it('trims a trailing slash off an absolute path', async () => {
    const { result } = await run([entry({ ...basic, remotePath: '/var/www/' })]);
    expect(result.config.servers.Prod.rootPath).toBe('/var/www');
  });
});

describe('mapEntries — names and collisions (Q4)', () => {
  const existingCredential: SshCredential = { id: 'c-old', name: 'Prod', host: 'prod.example.com', port: 22, username: 'deploy', authMethod: 'password' };
  const existingConfig: ProjectConfig = {
    defaultServerId: 's-old',
    uploadOnSave: false,
    servers: {
      Prod: { id: 's-old', type: 'sftp', credentialId: 'c-old', credentialName: 'Prod', rootPath: '/var/www', mappings: [{ localPath: '/', remotePath: '' }], excludedPaths: ['keep-me'] },
    },
  };

  it('skips an exact duplicate (host+port+username+remotePath) of an existing server and leaves the config untouched', async () => {
    const { result } = await run([entry(basic)], { existingConfig, existingCredentials: [existingCredential] });
    expect(result.config).toEqual(existingConfig);
    expect(result.credentials).toEqual([]);
    expect(result.report.skippedDuplicates).toEqual([{ entry: 'Prod', reason: expect.stringMatching(/already configured as "Prod"/) }]);
  });

  it('adds a non-duplicate next to existing servers, de-duplicating the name, never touching the existing default', async () => {
    const { result } = await run([entry({ ...basic, remotePath: '/srv/other' })], { existingConfig, existingCredentials: [existingCredential] });
    expect(Object.keys(result.config.servers)).toEqual(['Prod', 'Prod-2']);
    expect(result.config.servers.Prod).toEqual(existingConfig.servers.Prod);
    expect(result.config.defaultServerId).toBe('s-old');
    expect(result.config.uploadOnSave).toBe(false);
    expect(result.credentials[0].credential.name).toBe('Prod-2');
    expect(result.report.notes).toContainEqual({ entry: 'Prod', message: expect.stringMatching(/imported as "Prod-2"/) });
  });

  it('de-duplicates names case-insensitively within the batch and against existing credentials', async () => {
    const { result } = await run([
      entry({ ...basic }, { name: 'site' }),
      entry({ ...basic, password: 'other', remotePath: '/b' }, { name: 'SITE', isDefault: false }),
    ], { existingCredentials: [{ ...existingCredential, name: 'site-2' }] });
    expect(Object.keys(result.config.servers)).toEqual(['site', 'SITE-2']);
    expect(result.credentials.map((c) => c.credential.name)).toEqual(['site', 'SITE-3']);
  });

  it('skips a duplicate inside the same file', async () => {
    const { result } = await run([entry(basic, { name: 'Alpha' }), entry(basic, { name: 'Beta', isDefault: false })]);
    expect(Object.keys(result.config.servers)).toEqual(['Alpha']);
    expect(result.report.skippedDuplicates).toEqual([{ entry: 'Beta', reason: expect.stringMatching(/"Alpha"/) }]);
  });

  it('pads names shorter than 3 characters and clamps names longer than 50', async () => {
    const long = 'x'.repeat(60);
    const { result } = await run([entry(basic, { name: 'ab' }), entry({ ...basic, remotePath: '/b' }, { name: long, isDefault: false })]);
    const names = Object.keys(result.config.servers);
    expect(names[0]).toBe('ab server');
    expect(names[1]).toHaveLength(50);
  });

  it('shares one credential between entries with identical connection details', async () => {
    const { result, passwordPrompts } = await run([
      entry({ host: 'h', username: 'u', remotePath: '/a' }, { name: 'Alpha' }),
      entry({ host: 'h', username: 'u', remotePath: '/b' }, { name: 'Beta', isDefault: false }),
    ], { password: 'once' });
    expect(result.credentials).toHaveLength(1);
    expect(passwordPrompts).toEqual(['Alpha']);
    expect(result.config.servers.Beta.credentialId).toBe(result.config.servers.Alpha.credentialId);
    expect(result.config.servers.Beta.credentialName).toBe('Alpha');
  });
});

describe('mapEntries — default server and uploadOnSave (Q11 / 35a)', () => {
  it('the default entry sets defaultServerId and the global uploadOnSave; every entry keeps its own override', async () => {
    const { result } = await run([
      entry({ ...basic, uploadOnSave: true }, { name: 'dev', isDefault: false }),
      entry({ ...basic, remotePath: '/p', uploadOnSave: false }, { name: 'prod', isDefault: true }),
      entry({ ...basic, remotePath: '/s' }, { name: 'staging', isDefault: false }),
    ]);
    expect(result.config.defaultServerId).toBe(result.config.servers.prod.id);
    expect(result.config.uploadOnSave).toBe(false);
    expect(result.config.servers.dev.uploadOnSave).toBe(true);
    expect(result.config.servers.prod.uploadOnSave).toBe(false);
    expect(result.config.servers.staging).not.toHaveProperty('uploadOnSave');
  });

  it('falls back to the first imported server as default when no entry is marked default', async () => {
    const { result } = await run([entry({ ...basic, uploadOnSave: true }, { name: 'alpha', isDefault: false }), entry({ ...basic, remotePath: '/b' }, { name: 'beta', isDefault: false })]);
    expect(result.config.defaultServerId).toBe(result.config.servers.alpha.id);
    expect(result.config.uploadOnSave).toBe(true);
  });

  it('leaves the global uploadOnSave alone when the config already has one', async () => {
    const existingConfig: ProjectConfig = { defaultServerId: '', uploadOnSave: true, servers: {} };
    const { result } = await run([entry({ ...basic, uploadOnSave: false })], { existingConfig });
    expect(result.config.uploadOnSave).toBe(true);
    expect(result.config.defaultServerId).toBe(result.config.servers.Prod.id);
  });

  it('does not emit a global uploadOnSave when the default entry has none', async () => {
    const { result } = await run([entry(basic)]);
    expect(result.config).not.toHaveProperty('uploadOnSave');
  });
});

describe('mapEntries — ignore / ignoreFile (Q9 / Q10)', () => {
  it('translates ignore with the entry context and reports untranslatable patterns per entry', async () => {
    const { result } = await run([entry({ ...basic, ignore: ['.git', 'build/tmp', '!keep', 'dist/'] }, { context: 'web' })]);
    expect(result.config.servers.Prod.excludedPaths).toEqual(['.git', 'web/build/tmp']);
    expect(result.report.untranslatableIgnore).toEqual([
      { entry: 'Prod', pattern: '!keep', reason: expect.any(String) },
      { entry: 'Prod', pattern: 'dist/', reason: expect.any(String) },
    ]);
  });

  it('inlines ignoreFile patterns and notes that future edits will not carry over', async () => {
    const { result } = await run([entry({ ...basic, ignore: ['.git'], ignoreFile: '.sftpignore' })], { ignoreFiles: { '.sftpignore': '# comment\nnode_modules\n*.log\n.git\n' } });
    expect(result.config.servers.Prod.excludedPaths).toEqual(['.git', 'node_modules', '*.log']);
    expect(result.report.notes).toContainEqual({ entry: 'Prod', message: expect.stringMatching(/\.sftpignore.*inlined.*future edits/i) });
  });

  it('reports a missing ignoreFile without aborting', async () => {
    const { result } = await run([entry({ ...basic, ignoreFile: '.sftpignore' })], { ignoreFiles: { '.sftpignore': null } });
    expect(result.config.servers.Prod.excludedPaths).toEqual([]);
    expect(result.report.notes).toContainEqual({ entry: 'Prod', message: expect.stringMatching(/\.sftpignore.*could not be read/i) });
  });

  it('reports a non-array ignore as unsupported', async () => {
    const { result } = await run([entry({ ...basic, ignore: 'node_modules' })]);
    expect(result.config.servers.Prod.excludedPaths).toEqual([]);
    expect(result.report.unsupportedOptions[0].options[0]).toMatch(/^ignore /);
  });
});

describe('mapEntries — watcher, offsets, permissions', () => {
  it('maps watcher.files/autoUpload onto the global watch block once per root and flags autoDelete (Q16)', async () => {
    const watcher = { files: 'dist/**', autoUpload: true, autoDelete: true };
    const { result } = await run([
      entry(basic, { name: 'dev', watcher, isDefault: false }),
      entry({ ...basic, remotePath: '/p' }, { name: 'prod', watcher, isDefault: true }),
    ]);
    expect(result.config.watch).toEqual({ enabled: true, patterns: ['dist/**'] });
    const autoDeleteNotes = result.report.notes.filter((note) => /autoDelete/.test(note.message));
    expect(autoDeleteNotes).toHaveLength(1);
    expect(autoDeleteNotes[0].message).toMatch(/Sync to Remote/);
  });

  it('keeps an existing watch block and reports the watcher as not carried over', async () => {
    const existingConfig: ProjectConfig = { defaultServerId: '', servers: {}, watch: { enabled: false, patterns: ['old/**'] } };
    const { result } = await run([entry(basic, { watcher: { files: 'dist/**', autoUpload: true } })], { existingConfig });
    expect(result.config.watch).toEqual({ enabled: false, patterns: ['old/**'] });
    expect(result.report.notes).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/watcher.*existing watch/i) }));
  });

  it('a watcher with autoUpload off imports its pattern disabled', async () => {
    const { result } = await run([entry(basic, { watcher: { files: 'dist/**' } })]);
    expect(result.config.watch).toEqual({ enabled: false, patterns: ['dist/**'] });
  });

  it('converts remoteTimeOffsetInHours to timeOffsetMs', async () => {
    const { result } = await run([entry({ ...basic, remoteTimeOffsetInHours: -2.5 })]);
    expect(result.config.servers.Prod.timeOffsetMs).toBe(-9_000_000);
  });

  it.each([
    ['0644', 420], ['644', 420], [644, 420], ['0o755', 493], [493, 493], ['2775', undefined], ['abc', undefined],
  ])('filePerm %p → %p', async (filePerm, expected) => {
    const { result } = await run([entry({ ...basic, filePerm, dirPerm: '0755' })]);
    expect(result.config.servers.Prod.filePermissions).toBe(expected);
    expect(result.config.servers.Prod.directoryPermissions).toBe(493);
    if (expected === undefined) {
      expect(result.report.notes).toContainEqual({ entry: 'Prod', message: expect.stringMatching(/filePerm/) });
    }
  });
});

describe('mapEntries — hop chains (feature 18 contract)', () => {
  const hopEntry = entry({
    host: 'bastion.example.com', username: 'jump', password: 'b-pass', remotePath: '/srv/app',
    hop: [
      { host: 'mid.internal', username: 'mid', privateKeyPath: '/home/jump/.ssh/id_rsa' },
      { host: 'target.internal', port: 2200, username: 'app', password: 't-pass' },
    ],
  }, { name: 'App' });

  it('top-level host is hop 1, intermediate hop entries follow, the last hop entry is the target with jumpHosts', async () => {
    const { result } = await run([hopEntry]);
    expect(result.credentials.map((c) => c.credential)).toEqual([
      { id: 'id-1', name: 'App hop 1', host: 'bastion.example.com', port: 22, username: 'jump', authMethod: 'password' },
      { id: 'id-2', name: 'App hop 2', host: 'mid.internal', port: 22, username: 'mid', authMethod: 'key', privateKeyPath: '/home/jump/.ssh/id_rsa' },
      { id: 'id-3', name: 'App', host: 'target.internal', port: 2200, username: 'app', authMethod: 'password', jumpHosts: ['id-1', 'id-2'] },
    ]);
    expect(result.credentials.map((c) => c.password)).toEqual(['b-pass', undefined, 't-pass']);
    expect(result.config.servers.App).toMatchObject({ credentialId: 'id-3', credentialName: 'App', rootPath: '/srv/app' });
    expect(result.report.imported[0].hopCredentialNames).toEqual(['App hop 1', 'App hop 2']);
  });

  it('warns that a per-stage private key is treated as a local path', async () => {
    const { result } = await run([hopEntry]);
    expect(result.report.notes).toContainEqual({ entry: 'App', message: expect.stringMatching(/hop 2.*intermediate machines.*treated as local/i) });
  });

  it('accepts a single hop object', async () => {
    const { result } = await run([entry({ host: 'b', username: 'j', password: 'p', remotePath: '/', hop: { host: 't', username: 'a', password: 'q' } })]);
    expect(result.credentials.map((c) => c.credential.name)).toEqual(['Prod hop 1', 'Prod']);
    expect(result.credentials[1].credential.jumpHosts).toEqual(['id-1']);
  });

  it('prompts for a missing hop-stage password by the stage credential name', async () => {
    const { passwordPrompts, result } = await run([entry({ host: 'b', username: 'j', remotePath: '/', hop: { host: 't', username: 'a' } })], { password: undefined });
    expect(passwordPrompts).toEqual(['Prod hop 1', 'Prod']);
    expect(result.report.promptsSkipped).toHaveLength(2);
  });

  it('drops the chain on FTP with a report line and connects to the top-level host', async () => {
    const { result } = await run([entry({ ...basic, protocol: 'ftp', hop: [{ host: 't', username: 'a' }] })]);
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].credential.host).toBe('prod.example.com');
    expect(result.report.notes).toContainEqual({ entry: 'Prod', message: expect.stringMatching(/hop.*FTP/i) });
  });

  it('skips the entry when a hop stage has no host', async () => {
    const { result } = await run([entry({ host: 'b', username: 'j', remotePath: '/', hop: [{ username: 'a' }] })]);
    expect(result.credentials).toEqual([]);
    expect(result.report.skippedEntries).toEqual([{ entry: 'Prod', reason: expect.stringMatching(/hop 1 has no "host"/) }]);
  });

  it('duplicate detection uses the target host, not the bastion', async () => {
    const existingCredential: SshCredential = { id: 'c', name: 'T', host: 't', port: 22, username: 'a', authMethod: 'password' };
    const existingConfig: ProjectConfig = { defaultServerId: 's', servers: { T: { id: 's', type: 'sftp', credentialId: 'c', credentialName: 'T', rootPath: '/', mappings: [], excludedPaths: [] } } };
    const { result } = await run([entry({ host: 'b', username: 'j', password: 'p', remotePath: '/', hop: { host: 't', username: 'a', password: 'q' } })], { existingConfig, existingCredentials: [existingCredential] });
    expect(result.credentials).toEqual([]);
    expect(result.report.skippedDuplicates).toHaveLength(1);
  });
});

describe('mapEntries — the skip bucket', () => {
  it('lists every unmapped option per entry, with a reason for the notable ones', async () => {
    const { result } = await run([entry({ ...basic, syncOption: { delete: true }, concurrency: 4, sshConfigPath: '~/.ssh/config', remote: 'box', downloadOnOpen: true })]);
    expect(result.report.unsupportedOptions).toEqual([{
      entry: 'Prod',
      options: [
        'concurrency',
        'downloadOnOpen',
        expect.stringMatching(/^remote \(/),
        expect.stringMatching(/^sshConfigPath \(/),
        'syncOption',
      ],
    }]);
  });
});
