import { parseSftpJson, SftpJsonParseError } from '../../../../importers/vscodeSftp/parser';

// Feature 35b: sftp.json comes in three shapes (single object, array of
// entries, profiles under one object). The parser flattens all three into one
// entry per future server and reports what it dropped — it never guesses.

describe('parseSftpJson', () => {
  it('throws a typed error on invalid JSON', () => {
    expect(() => parseSftpJson('{ not json')).toThrow(SftpJsonParseError);
  });

  it('tolerates comments and trailing commas (VS Code treats .vscode/*.json as JSONC)', () => {
    const text = `{
      // the deploy box
      "name": "Prod", /* block */
      "host": "prod.example.com",
      "remotePath": "/var/www", // trailing comment with a "quote"
    }`;
    const result = parseSftpJson(text);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].raw.host).toBe('prod.example.com');
  });

  it('throws when the top level is neither an object nor an array', () => {
    expect(() => parseSftpJson('"just a string"')).toThrow(SftpJsonParseError);
    expect(() => parseSftpJson('42')).toThrow(SftpJsonParseError);
  });

  describe('single object', () => {
    it('yields one default entry named after `name`', () => {
      const result = parseSftpJson(JSON.stringify({ name: 'My Server', host: 'h', username: 'u' }));
      expect(result.entries).toEqual([
        expect.objectContaining({ name: 'My Server', isDefault: true, raw: expect.objectContaining({ host: 'h' }) }),
      ]);
      expect(result.notices).toEqual([]);
    });

    it('falls back to the host as the name when `name` is absent', () => {
      const result = parseSftpJson(JSON.stringify({ host: 'prod.example.com', username: 'u' }));
      expect(result.entries[0].name).toBe('prod.example.com');
    });

    it('carries `context` out of the raw object', () => {
      const result = parseSftpJson(JSON.stringify({ name: 'S', host: 'h', context: './src' }));
      expect(result.entries[0].context).toBe('./src');
    });
  });

  describe('array form', () => {
    it('yields one entry per element, first one default, each with its own context', () => {
      const result = parseSftpJson(JSON.stringify([
        { name: 'Frontend', context: 'web', host: 'a', remotePath: '/srv/web' },
        { name: 'Backend', context: 'api', host: 'b', remotePath: '/srv/api' },
      ]));
      expect(result.entries.map((entry) => [entry.name, entry.context, entry.isDefault])).toEqual([
        ['Frontend', 'web', true],
        ['Backend', 'api', false],
      ]);
    });

    it('skips non-object elements with a notice instead of aborting', () => {
      const result = parseSftpJson(JSON.stringify([{ name: 'A', host: 'a' }, 'oops', null]));
      expect(result.entries).toHaveLength(1);
      expect(result.notices).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/entry 2 .*not an object/i) }),
        expect.objectContaining({ message: expect.stringMatching(/entry 3 .*not an object/i) }),
      ]);
    });

    it('names an unnamed array entry after its host with a notice', () => {
      const result = parseSftpJson(JSON.stringify([{ host: 'x.example.com', context: 'x' }]));
      expect(result.entries[0].name).toBe('x.example.com');
      expect(result.notices[0].message).toMatch(/no "name"/i);
    });
  });

  describe('profiles', () => {
    const withProfiles = {
      name: 'Site',
      host: 'shared.example.com',
      username: 'deploy',
      remotePath: '/var/www',
      ignore: ['.git'],
      watcher: { files: 'dist/**', autoUpload: true },
      defaultProfile: 'prod',
      profiles: {
        dev: { host: 'dev.example.com', remotePath: '/var/www/dev', uploadOnSave: true },
        prod: { password: 'hunter2' },
      },
    };

    it('yields one entry per profile named by the profile key, merged onto the top level', () => {
      const result = parseSftpJson(JSON.stringify(withProfiles));
      expect(result.entries.map((entry) => entry.name)).toEqual(['dev', 'prod']);
      const dev = result.entries[0];
      expect(dev.profile).toBe('dev');
      expect(dev.raw).toEqual({
        host: 'dev.example.com',
        username: 'deploy',
        remotePath: '/var/www/dev',
        ignore: ['.git'],
        uploadOnSave: true,
      });
      expect(result.entries[1].raw).toEqual({
        host: 'shared.example.com',
        username: 'deploy',
        remotePath: '/var/www',
        ignore: ['.git'],
        password: 'hunter2',
      });
    });

    it('marks the defaultProfile entry as default and keeps root-only keys on the entries', () => {
      const result = parseSftpJson(JSON.stringify(withProfiles));
      expect(result.entries.map((entry) => entry.isDefault)).toEqual([false, true]);
      // watcher is root-only: every profile entry sees the same watcher
      expect(result.entries[0].watcher).toEqual({ files: 'dist/**', autoUpload: true });
      expect(result.entries[1].watcher).toEqual({ files: 'dist/**', autoUpload: true });
    });

    it('marks no entry as default when defaultProfile is absent', () => {
      const { defaultProfile: _dropped, ...noDefault } = withProfiles;
      const result = parseSftpJson(JSON.stringify(noDefault));
      expect(result.entries.every((entry) => !entry.isDefault)).toBe(true);
    });

    it('reports a defaultProfile that names no profile', () => {
      const result = parseSftpJson(JSON.stringify({ ...withProfiles, defaultProfile: 'staging' }));
      expect(result.notices).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/defaultProfile "staging"/) }),
      ]);
    });

    it('drops root-only keys found inside a profile and says so', () => {
      const result = parseSftpJson(JSON.stringify({
        host: 'h',
        profiles: { dev: { host: 'd', watcher: { files: 'x' }, context: 'src', name: 'ignored' } },
      }));
      expect(result.entries[0].raw).toEqual({ host: 'd' });
      expect(result.notices.map((notice) => notice.message)).toEqual([
        expect.stringMatching(/profile "dev".*context, name, watcher.*root-only/i),
      ]);
    });

    it('skips a profile that is not an object', () => {
      const result = parseSftpJson(JSON.stringify({ host: 'h', profiles: { dev: 'nope', prod: { host: 'p' } } }));
      expect(result.entries.map((entry) => entry.name)).toEqual(['prod']);
      expect(result.notices[0].message).toMatch(/profile "dev" .*not an object/i);
    });

    it('prefixes profile names with the entry name in the array form', () => {
      const result = parseSftpJson(JSON.stringify([
        { name: 'Site', context: 'site', host: 'h', profiles: { dev: { host: 'd' } } },
      ]));
      expect(result.entries[0].name).toBe('Site dev');
      expect(result.entries[0].context).toBe('site');
    });
  });
});
