import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';

jest.mock('fs/promises');
jest.mock('../../../services/UploadHistoryService');
jest.mock('../../../services/StrictRemoteTreeWalker');

import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { walkRemoteTreeStrict } from '../../../services/StrictRemoteTreeWalker';
import { duplicateRemoteItem } from '../../../commands/duplicateRemoteItem';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

const mockWalkRemoteTreeStrict = walkRemoteTreeStrict as jest.Mock;

const vscode = require('vscode');

// Test expectations derive from the SAME path calls the source makes — the CI
// matrix runs ubuntu + windows, so a hardcoded separator would break there.
const TEMP_DIR = path.join(os.tmpdir(), 'fileferry-browse');

function expectedTempPath(name: string, remotePath: string): string {
  const hash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
  return path.join(TEMP_DIR, `${name}.duplicate.${hash}`);
}

const mockConnection = {
  downloadFile: jest.fn(),
  uploadFile: jest.fn(),
  exists: jest.fn(),
  statRemoteType: jest.fn(),
  createDirectory: jest.fn(),
};

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
};

const mockOutput = { appendLine: jest.fn() };
const mockRefresh = jest.fn();

const mockHistoryLog = jest.fn();
const mockHistoryEnforceRetention = jest.fn();
(UploadHistoryService as unknown as jest.Mock).mockImplementation(() => ({
  log: mockHistoryLog,
  enforceRetention: mockHistoryEnforceRetention,
}));

const server = {
  id: 'server-1', type: 'sftp' as const,
  credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/var/www', mappings: [], excludedPaths: [],
};
const baseConfig = { defaultServerId: 'server-1', servers: { Production: server }, dryRun: false };

function makeItem(overrides: Partial<RemoteEntry> & { name: string; remotePath: string }): RemoteFileItem {
  const entry: RemoteEntry = {
    type: '-',
    size: 1024,
    modifyTime: 1710000000000,
    ...overrides,
  };
  return new RemoteFileItem(entry);
}

describe('duplicateRemoteItem', () => {
  function dependencies() {
    return {
      connection: mockConnection as any,
      configManager: mockConfigManager as any,
      output: mockOutput as any,
      refresh: mockRefresh,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();

    vscode.window.showInputBox.mockResolvedValue('index copy.php');
    vscode.window.withProgress.mockImplementation(
      (_options: any, task: (progress: any) => Promise<any>) => task({ report: jest.fn() })
    );
    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server });
    mockConnection.downloadFile.mockResolvedValue(Buffer.from('content'));
    mockConnection.uploadFile.mockResolvedValue(undefined);
    mockConnection.exists.mockResolvedValue(false);
    mockConnection.statRemoteType.mockResolvedValue(null);
    mockConnection.createDirectory.mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
    mockHistoryLog.mockResolvedValue(undefined);
    mockHistoryEnforceRetention.mockResolvedValue(undefined);
    mockWalkRemoteTreeStrict.mockResolvedValue({ files: [], directories: [], symlinks: [], totalBytes: 0 });
  });

  describe('single target', () => {
    it('does nothing when the target list is empty', async () => {
      await duplicateRemoteItem([], dependencies());

      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
    });

    it('prefills "<stem> copy<ext>" and selects everything but the extension', async () => {
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
      expect(inputBoxOptions.value).toBe('index copy.php');
      expect(inputBoxOptions.valueSelection).toEqual([0, 10]);
    });

    it('wires the shared name validator into the input box', async () => {
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
      expect(inputBoxOptions.validateInput('a/b')).toBeTruthy();
      expect(inputBoxOptions.validateInput('a\\b')).toBeTruthy();
      expect(inputBoxOptions.validateInput('..')).toBeTruthy();
      expect(inputBoxOptions.validateInput('   ')).toBeTruthy();
      expect(inputBoxOptions.validateInput('index copy.php')).toBeFalsy();
    });

    it('does nothing when the input box is cancelled', async () => {
      vscode.window.showInputBox.mockResolvedValue(undefined);
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      expect(mockConnection.statRemoteType).not.toHaveBeenCalled();
      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('is a silent no-op when the entered name equals the source name', async () => {
      vscode.window.showInputBox.mockResolvedValue('index.php');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('downloads to a temp file, uploads to the new path, and cleans the temp up', async () => {
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });
      const tempPath = expectedTempPath('index.php', '/var/www/index.php');

      await duplicateRemoteItem([item], dependencies());

      expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/www/index.php');
      expect(fs.writeFile).toHaveBeenCalledWith(tempPath, Buffer.from('content'));
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(tempPath, '/var/www/index copy.php');
      expect(fs.unlink).toHaveBeenCalledWith(tempPath);
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(check) Duplicated'),
        expect.any(Number)
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('does not double the slash when duplicating at the filesystem root', async () => {
      vscode.window.showInputBox.mockResolvedValue('file copy.txt');
      const item = makeItem({ name: 'file.txt', remotePath: '/file.txt' });

      await duplicateRemoteItem([item], dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/file copy.txt');
    });

    it('unlinks the temp file even when the upload fails', async () => {
      mockConnection.uploadFile.mockRejectedValue(new Error('Permission denied'));
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });
      const tempPath = expectedTempPath('index.php', '/var/www/index.php');

      await duplicateRemoteItem([item], dependencies());

      expect(fs.unlink).toHaveBeenCalledWith(tempPath);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('logs a success history row with the remote-duplicate trigger', async () => {
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });
      const tempPath = expectedTempPath('index.php', '/var/www/index.php');

      await duplicateRemoteItem([item], dependencies());

      expect(mockHistoryLog).toHaveBeenCalledWith([
        expect.objectContaining({
          serverId: 'server-1',
          serverName: 'Production',
          localPath: tempPath,
          remotePath: '/var/www/index copy.php',
          action: 'upload',
          result: 'success',
          trigger: 'remote-duplicate',
        }),
      ]);
      expect(mockHistoryEnforceRetention).toHaveBeenCalled();
    });

    it('logs a failed history row when the copy fails', async () => {
      mockConnection.downloadFile.mockRejectedValue(new Error('Connection lost'));
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      expect(mockHistoryLog).toHaveBeenCalledWith([
        expect.objectContaining({
          result: 'failed',
          error: 'Connection lost',
          trigger: 'remote-duplicate',
        }),
      ]);
    });

    it('a history failure never masks a completed duplicate', async () => {
      mockHistoryLog.mockRejectedValue(new Error('disk full'));
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(check) Duplicated'),
        expect.any(Number)
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('disk full')
      );
    });

    it('honours dry run before any network call', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        '[remote-duplicate] DRY RUN — would duplicate /var/www/index.php → /var/www/index copy.php (Production)'
      );
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(beaker)'),
        expect.any(Number)
      );
      expect(mockConnection.statRemoteType).not.toHaveBeenCalled();
      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockHistoryLog).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('explicit-name collision with a file prompts Overwrite/Cancel — Overwrite proceeds', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue('Overwrite');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('index copy.php'),
        expect.objectContaining({ modal: true }),
        'Overwrite'
      );
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/index copy.php');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('explicit-name collision with a file: Cancel copies nothing', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue(undefined);
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('explicit-name collision with a folder aborts with an error, never merges', async () => {
      mockConnection.statRemoteType.mockResolvedValue('d');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await duplicateRemoteItem([item], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('index copy.php')
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('multiple targets', () => {
    const itemA = () => makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
    const itemB = () => makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });
    const itemC = () => makeItem({ name: 'c.txt', remotePath: '/var/www/c.txt' });

    it('never prompts: auto-names every copy and uploads them sequentially', async () => {
      await duplicateRemoteItem([itemA(), itemB(), itemC()], dependencies());

      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/a copy.txt');
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/b copy.txt');
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/c copy.txt');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Duplicated 3 files')
      );
    });

    it('uses a notification progress with the count for several targets', async () => {
      await duplicateRemoteItem([itemA(), itemB()], dependencies());

      const progressOptions = vscode.window.withProgress.mock.calls[0][0];
      expect(progressOptions.location).toBe(vscode.ProgressLocation.Notification);
      expect(progressOptions.title).toContain('2');
    });

    it('numbers past a taken base name: "copy" taken → "copy 2"', async () => {
      mockConnection.exists.mockImplementation(async (remotePath: string) =>
        remotePath === '/var/www/a copy.txt'
      );

      await duplicateRemoteItem([itemA(), itemB()], dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/a copy 2.txt');
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/b copy.txt');
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('skips a file when "copy" through "copy 9" are all taken, and names it in the summary', async () => {
      mockConnection.exists.mockImplementation(async (remotePath: string) =>
        remotePath.startsWith('/var/www/a copy')
      );

      await duplicateRemoteItem([itemA(), itemB()], dependencies());

      expect(mockConnection.uploadFile).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining('a copy'));
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/b copy.txt');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('a.txt')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('continues past a failure, aggregates it, and still refreshes once', async () => {
      mockConnection.downloadFile
        .mockRejectedValueOnce(new Error('Permission denied'))
        .mockResolvedValue(Buffer.from('content'));

      await duplicateRemoteItem([itemA(), itemB()], dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/b copy.txt');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('a.txt')
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('logs one history row per file, success and failure alike', async () => {
      mockConnection.downloadFile
        .mockRejectedValueOnce(new Error('Permission denied'))
        .mockResolvedValue(Buffer.from('content'));

      await duplicateRemoteItem([itemA(), itemB()], dependencies());

      const loggedEntries = mockHistoryLog.mock.calls.flatMap(call => call[0]);
      expect(loggedEntries).toEqual(expect.arrayContaining([
        expect.objectContaining({ remotePath: '/var/www/a copy.txt', result: 'failed', trigger: 'remote-duplicate' }),
        expect.objectContaining({ remotePath: '/var/www/b copy.txt', result: 'success', trigger: 'remote-duplicate' }),
      ]));
    });

    it('honours dry run before any network call, logging the plan per file', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });

      await duplicateRemoteItem([itemA(), itemB()], dependencies());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('DRY RUN — would duplicate /var/www/a.txt')
      );
      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('DRY RUN — would duplicate /var/www/b.txt')
      );
      expect(mockConnection.exists).not.toHaveBeenCalled();
      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('folder targets (33g)', () => {
    const folderItem = () =>
      makeItem({ name: 'assets', type: 'd', size: 4096, remotePath: '/var/www/assets' });

    const snapshot = () => ({
      files: [
        { remotePath: '/var/www/assets/logo.png', size: 1000 },
        { remotePath: '/var/www/assets/css/site.css', size: 200 },
      ],
      directories: ['/var/www/assets/css', '/var/www/assets/empty'],
      symlinks: ['/var/www/assets/current'],
      totalBytes: 1200,
    });

    beforeEach(() => {
      vscode.window.showInputBox.mockResolvedValue('assets copy');
      vscode.window.showWarningMessage.mockResolvedValue('Duplicate');
      mockWalkRemoteTreeStrict.mockResolvedValue(snapshot());
    });

    it('prefills "<name> copy" with the WHOLE name selected — no extension split on folders', async () => {
      vscode.window.showInputBox.mockResolvedValue(undefined);
      const item = makeItem({ name: 'v1.2', type: 'd', size: 4096, remotePath: '/var/www/v1.2' });

      await duplicateRemoteItem([item], dependencies());

      const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
      expect(inputBoxOptions.value).toBe('v1.2 copy');
      expect(inputBoxOptions.valueSelection).toEqual([0, 9]);
    });

    it('pre-walks, then confirms once with the real counts and the skipped symlink named', async () => {
      vscode.window.showWarningMessage.mockResolvedValue(undefined); // cancel

      await duplicateRemoteItem([folderItem()], dependencies());

      expect(mockWalkRemoteTreeStrict).toHaveBeenCalledWith(mockConnection, '/var/www/assets');
      const [message, options] = vscode.window.showWarningMessage.mock.calls[0];
      expect(message).toContain('assets');
      expect(message).toContain('assets copy');
      expect(message).toContain('2 files');
      expect(message).toContain('1 symlink');
      expect(options.modal).toBe(true);
      expect(options.detail).toContain('/var/www/assets/current');
      // Cancelled: nothing was written
      expect(mockConnection.createDirectory).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('recreates the skeleton (empty directory included) and copies every file into it', async () => {
      await duplicateRemoteItem([folderItem()], dependencies());

      const createdDirectories = mockConnection.createDirectory.mock.calls.map(call => call[0]);
      expect(createdDirectories).toEqual([
        '/var/www/assets copy',
        '/var/www/assets copy/css',
        '/var/www/assets copy/empty',
      ]);
      expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/www/assets/logo.png');
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/assets copy/logo.png');
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/assets copy/css/site.css');
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(check)'),
        expect.any(Number)
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('logs one batched history call with a remote-duplicate row per copied file', async () => {
      await duplicateRemoteItem([folderItem()], dependencies());

      expect(mockHistoryLog).toHaveBeenCalledTimes(1);
      const entries = mockHistoryLog.mock.calls[0][0];
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual(expect.objectContaining({
        remotePath: '/var/www/assets copy/logo.png',
        trigger: 'remote-duplicate',
        result: 'success',
      }));
    });

    it('a name collision aborts with an error — folders are never overwritten or merged', async () => {
      mockConnection.statRemoteType.mockResolvedValue('d');

      await duplicateRemoteItem([folderItem()], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('assets copy')
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockWalkRemoteTreeStrict).not.toHaveBeenCalled();
      expect(mockConnection.createDirectory).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    });

    it('aborts before any write when the pre-walk fails — no partial copy from a blind spot', async () => {
      mockWalkRemoteTreeStrict.mockRejectedValue(new Error('Permission denied: /var/www/assets/css'));

      await duplicateRemoteItem([folderItem()], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.createDirectory).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('honours dry run: pre-walks for the counts, logs the plan, writes nothing, never confirms', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });

      await duplicateRemoteItem([folderItem()], dependencies());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('DRY RUN — would duplicate /var/www/assets → /var/www/assets copy')
      );
      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('2 files')
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.createDirectory).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('cancellation stops the copy and reports the partial result honestly', async () => {
      let cancelRequested = false;
      vscode.window.withProgress.mockImplementation(
        (_options: any, task: (progress: any, token: any) => Promise<any>) =>
          task({ report: jest.fn() }, { get isCancellationRequested() { return cancelRequested; } })
      );
      mockConnection.uploadFile.mockImplementation(async () => { cancelRequested = true; });

      await duplicateRemoteItem([folderItem()], dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('cancelled')
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 remaining')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('continues past a failed file and lists the failed path in the aggregate error', async () => {
      mockConnection.downloadFile
        .mockRejectedValueOnce(new Error('Connection reset'))
        .mockResolvedValue(Buffer.from('content'));

      await duplicateRemoteItem([folderItem()], dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/assets copy/css/site.css');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('/var/www/assets/logo.png')
      );
      const entries = mockHistoryLog.mock.calls[0][0];
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ result: 'failed', error: 'Connection reset' }),
        expect.objectContaining({ remotePath: '/var/www/assets copy/css/site.css', result: 'success' }),
      ]));
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('an empty folder duplicates as skeleton only', async () => {
      mockWalkRemoteTreeStrict.mockResolvedValue({
        files: [], directories: ['/var/www/assets/empty'], symlinks: [], totalBytes: 0,
      });

      await duplicateRemoteItem([folderItem()], dependencies());

      expect(mockConnection.createDirectory).toHaveBeenCalledWith('/var/www/assets copy');
      expect(mockConnection.createDirectory).toHaveBeenCalledWith('/var/www/assets copy/empty');
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    describe('in a multi-selection', () => {
      it('confirms ONCE with aggregate counts, auto-names without prompting, copies both kinds', async () => {
        const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });

        await duplicateRemoteItem([folderItem(), fileItem], dependencies());

        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        const [message] = vscode.window.showWarningMessage.mock.calls[0];
        expect(message).toContain('2 items');
        expect(message).toContain('3 files'); // 2 walked + 1 direct
        expect(mockConnection.createDirectory).toHaveBeenCalledWith('/var/www/assets copy');
        expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/assets copy/logo.png');
        expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/a copy.txt');
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });

      it('numbers a folder copy past a taken name without an extension split', async () => {
        mockConnection.exists.mockImplementation(async (remotePath: string) =>
          remotePath === '/var/www/assets copy'
        );

        await duplicateRemoteItem([folderItem(), makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' })], dependencies());

        expect(mockConnection.createDirectory).toHaveBeenCalledWith('/var/www/assets copy 2');
        expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/var/www/assets copy 2/logo.png');
      });

      it('a pure-file multi-selection still never sees a confirmation (33c behaviour pinned)', async () => {
        const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
        const otherItem = makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });

        await duplicateRemoteItem([fileItem, otherItem], dependencies());

        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(mockWalkRemoteTreeStrict).not.toHaveBeenCalled();
        expect(mockConnection.uploadFile).toHaveBeenCalledTimes(2);
      });
    });
  });
});
