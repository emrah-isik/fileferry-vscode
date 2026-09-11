import * as vscode from 'vscode';
import * as path from 'path';
import { importFromVscodeSftp, ImportFromVscodeSftpDependencies, vscodePrompts } from '../../../commands/importFromVscodeSftp';
import { ImportPrompts } from '../../../importers/vscodeSftp/mapper';
import { ProjectConfig } from '../../../models/ProjectConfig';
import { SshCredential } from '../../../models/SshCredential';

// Feature 35b: the command is thin glue — read, parse, resolve ignoreFile,
// map with prompts, write credentials then config, refresh, report.

// The command joins with the platform separator (Windows CI), so the fake
// file map is keyed the same way.
const SFTP_JSON = path.join('/work', '.vscode', 'sftp.json');
const IGNORE_FILE = path.resolve('/work', '.sftpignore');

describe('importFromVscodeSftp', () => {
  let files: Record<string, string>;
  let config: ProjectConfig | null;
  let storedCredentials: SshCredential[];
  let secrets: Record<string, { password?: string; passphrase?: string }>;
  let writes: string[];
  let outputLines: string[];
  let afterWriteCalls: number;
  let prompts: ImportPrompts;
  const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
  const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
  const showErrorMessage = vscode.window.showErrorMessage as jest.Mock;
  const showInputBox = vscode.window.showInputBox as jest.Mock;

  function dependencies(overrides: Partial<ImportFromVscodeSftpDependencies> = {}): ImportFromVscodeSftpDependencies {
    return {
      workspaceRoot: '/work',
      readFile: async (absolutePath) => files[absolutePath] ?? null,
      configManager: {
        getConfig: async () => config,
        saveConfig: async (next) => { writes.push('config'); config = next; },
      },
      credentialManager: {
        getAll: async () => storedCredentials,
        save: async (credential, password, passphrase) => {
          writes.push(`credential:${credential.name}`);
          storedCredentials.push(credential);
          secrets[credential.id] = { password, passphrase };
        },
      },
      output: { appendLine: (line: string) => { outputLines.push(line); }, show: jest.fn() },
      prompts,
      afterWrite: () => { afterWriteCalls++; },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    files = {};
    config = null;
    storedCredentials = [];
    secrets = {};
    writes = [];
    outputLines = [];
    afterWriteCalls = 0;
    prompts = { askPassword: async () => 'typed', askRootPath: async () => '/srv/typed' };
  });

  it('errors without a workspace', async () => {
    expect(await importFromVscodeSftp(dependencies({ workspaceRoot: undefined }))).toBe('no-workspace');
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/Open a folder/));
  });

  it('errors when .vscode/sftp.json is missing', async () => {
    expect(await importFromVscodeSftp(dependencies())).toBe('no-sftp-json');
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/No \.vscode\/sftp\.json/));
    expect(writes).toEqual([]);
  });

  it('errors on invalid JSON, logging the reason', async () => {
    files[SFTP_JSON] = '{ nope';
    expect(await importFromVscodeSftp(dependencies())).toBe('invalid');
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/));
    expect(outputLines[0]).toMatch(/\[error\] Import from vscode-sftp: .*not valid JSON/);
    expect(writes).toEqual([]);
  });

  it('imports: credentials first, then the config, then afterWrite; report to output, summary as a notification', async () => {
    files[SFTP_JSON] = JSON.stringify({ name: 'Prod', host: 'h', username: 'u', password: 'p', remotePath: '/var/www' });
    expect(await importFromVscodeSftp(dependencies())).toBe('imported');
    expect(writes).toEqual(['credential:Prod', 'config']);
    expect(afterWriteCalls).toBe(1);
    expect(config?.servers.Prod).toMatchObject({ rootPath: '/var/www', credentialName: 'Prod' });
    expect(config?.defaultServerId).toBe(config?.servers.Prod.id);
    expect(secrets[storedCredentials[0].id]).toEqual({ password: 'p', passphrase: undefined });
    expect(outputLines[0]).toMatch(/IMPORT FROM VSCODE-SFTP/);
    expect(outputLines[1]).toBe(`Source: ${SFTP_JSON}`);
    expect(outputLines.join('\n')).toMatch(/Imported servers \(1\)/);
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/imported 1 server from sftp\.json/));
  });

  it('never modifies sftp.json', async () => {
    const original = JSON.stringify({ name: 'Prod', host: 'h', username: 'u', password: 'p', remotePath: '/x' });
    files[SFTP_JSON] = original;
    await importFromVscodeSftp(dependencies());
    expect(files[SFTP_JSON]).toBe(original);
  });

  it('resolves ignoreFile relative to the workspace root and inlines it', async () => {
    files[SFTP_JSON] = JSON.stringify({ name: 'Prod', host: 'h', username: 'u', password: 'p', remotePath: '/x', ignoreFile: '.sftpignore' });
    files[IGNORE_FILE] = 'node_modules\n';
    await importFromVscodeSftp(dependencies());
    expect(config?.servers.Prod.excludedPaths).toEqual(['node_modules']);
  });

  it('routes the Q13/Q14 prompts through the injected prompts', async () => {
    files[SFTP_JSON] = JSON.stringify({ name: 'Prod', host: 'h', username: 'u', remotePath: './' });
    await importFromVscodeSftp(dependencies());
    expect(config?.servers.Prod.rootPath).toBe('/srv/typed');
    expect(secrets[storedCredentials[0].id].password).toBe('typed');
  });

  it('writes nothing and warns when every entry was skipped', async () => {
    prompts = { askPassword: async () => undefined, askRootPath: async () => undefined };
    files[SFTP_JSON] = JSON.stringify({ name: 'Prod', host: 'h', username: 'u', remotePath: './' });
    expect(await importFromVscodeSftp(dependencies())).toBe('nothing-imported');
    expect(writes).toEqual([]);
    expect(afterWriteCalls).toBe(0);
    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/no servers imported/));
    expect(outputLines.join('\n')).toMatch(/No servers were imported/);
  });

  it('is additive over an existing config and keeps its default server', async () => {
    const existingCredential: SshCredential = { id: 'c1', name: 'Old', host: 'old', port: 22, username: 'o', authMethod: 'password' };
    storedCredentials = [existingCredential];
    config = { defaultServerId: 's1', servers: { Old: { id: 's1', type: 'sftp', credentialId: 'c1', credentialName: 'Old', rootPath: '/o', mappings: [], excludedPaths: [] } } };
    files[SFTP_JSON] = JSON.stringify({ name: 'New', host: 'h', username: 'u', password: 'p', remotePath: '/n' });
    await importFromVscodeSftp(dependencies());
    expect(Object.keys(config!.servers)).toEqual(['Old', 'New']);
    expect(config!.defaultServerId).toBe('s1');
  });

  describe('vscodePrompts', () => {
    it('asks for the root path with / prefilled and validates the slash', async () => {
      showInputBox.mockResolvedValueOnce('/srv/app');
      await expect(vscodePrompts.askRootPath({ name: 'Prod', relativePath: './' })).resolves.toBe('/srv/app');
      const options = showInputBox.mock.calls[0][0];
      expect(options).toMatchObject({ value: '/', ignoreFocusOut: true, prompt: expect.stringMatching(/"Prod".*"\.\/"/) });
      expect(options.validateInput('relative')).toMatch(/start with \//);
      expect(options.validateInput('/ok')).toBeUndefined();
    });

    it('asks for the password masked, naming user@host:port and the keychain', async () => {
      showInputBox.mockResolvedValueOnce(undefined);
      await expect(vscodePrompts.askPassword({ credentialName: 'Prod', username: 'u', host: 'h', port: 22 })).resolves.toBeUndefined();
      expect(showInputBox.mock.calls[0][0]).toMatchObject({ password: true, ignoreFocusOut: true, prompt: expect.stringMatching(/u@h:22.*keychain/) });
    });
  });
});
