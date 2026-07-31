import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';

jest.mock('fs/promises');
jest.mock('../../../services/UploadHistoryService');

import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { duplicateRemoteItem } from '../../../commands/duplicateRemoteItem';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

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
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
    mockHistoryLog.mockResolvedValue(undefined);
    mockHistoryEnforceRetention.mockResolvedValue(undefined);
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

    it('defensively skips folders in the selection and says so in the summary', async () => {
      const folderItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });

      await duplicateRemoteItem([itemA(), folderItem, itemB()], dependencies());

      expect(mockConnection.downloadFile).not.toHaveBeenCalledWith('/var/www/logs');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('folder')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
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
});
