import * as path from 'path';

jest.mock('../../../services/UploadHistoryService');
jest.mock('../../../services/SyncTreeWalker');
jest.mock('../../../commands/pickLocalDirectory');

import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { walkLocalTree } from '../../../services/SyncTreeWalker';
import { pickLocalDirectory } from '../../../commands/pickLocalDirectory';
import { uploadFilesHere, uploadFolderHere } from '../../../commands/uploadHere';

const vscode = require('vscode');

const mockWalkLocalTree = walkLocalTree as jest.Mock;
const mockPickLocalDirectory = pickLocalDirectory as jest.Mock;

const mockConnection = {
  uploadFile: jest.fn(),
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

function uri(fsPath: string) {
  return { fsPath };
}

describe('uploadHere', () => {
  let cancelRequested: boolean;

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
    cancelRequested = false;

    vscode.window.showWarningMessage.mockResolvedValue('Upload');
    vscode.window.withProgress.mockImplementation(
      (_options: any, task: (progress: any, token: any) => Promise<any>) =>
        task({ report: jest.fn() }, { get isCancellationRequested() { return cancelRequested; } })
    );
    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server });
    mockConnection.uploadFile.mockResolvedValue(undefined);
    mockConnection.createDirectory.mockResolvedValue(undefined);
    mockHistoryLog.mockResolvedValue(undefined);
    mockHistoryEnforceRetention.mockResolvedValue(undefined);
    mockWalkLocalTree.mockReturnValue([]);
  });

  describe('uploadFilesHere', () => {
    beforeEach(() => {
      vscode.window.showOpenDialog.mockResolvedValue([
        uri(path.join('/home/emo/project', 'a.txt')),
        uri(path.join('/home/emo/project', 'b.txt')),
      ]);
    });

    it('opens a multi-select file dialog and does nothing when it is dismissed', async () => {
      vscode.window.showOpenDialog.mockResolvedValue(undefined);

      await uploadFilesHere('/var/www/html', dependencies());

      const dialogOptions = vscode.window.showOpenDialog.mock.calls[0][0];
      expect(dialogOptions.canSelectMany).toBe(true);
      expect(dialogOptions.canSelectFiles).toBe(true);
      expect(dialogOptions.canSelectFolders).toBe(false);
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('starts the dialog at the workspace root, not wherever the window last browsed', async () => {
      await uploadFilesHere('/var/www/html', dependencies());

      const dialogOptions = vscode.window.showOpenDialog.mock.calls[0][0];
      expect(dialogOptions.defaultUri).toEqual(
        expect.objectContaining({ fsPath: '/tmp/workspace' })
      );
    });

    it('confirms once with the exact count, the bypass note, and the overwrite warning', async () => {
      await uploadFilesHere('/var/www/html', dependencies());

      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      const [message, options] = vscode.window.showWarningMessage.mock.calls[0];
      expect(message).toContain('2 files');
      expect(message).toContain('/var/www/html');
      expect(options.modal).toBe(true);
      expect(options.detail).toContain('bypasses');
      expect(options.detail).toContain('overwritten');
    });

    it('does nothing when the confirmation is cancelled', async () => {
      vscode.window.showWarningMessage.mockResolvedValue(undefined);

      await uploadFilesHere('/var/www/html', dependencies());

      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockHistoryLog).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('uploads each picked file next to the clicked folder and refreshes once', async () => {
      await uploadFilesHere('/var/www/html', dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledWith(
        path.join('/home/emo/project', 'a.txt'), '/var/www/html/a.txt'
      );
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(
        path.join('/home/emo/project', 'b.txt'), '/var/www/html/b.txt'
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 files')
      );
    });

    it('does not double the slash when uploading to the filesystem root', async () => {
      await uploadFilesHere('/', dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledWith(expect.any(String), '/a.txt');
    });

    it('logs one remote-upload history row per file and enforces retention once', async () => {
      await uploadFilesHere('/var/www/html', dependencies());

      expect(mockHistoryLog).toHaveBeenCalledTimes(1);
      const entries = mockHistoryLog.mock.calls[0][0];
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual(expect.objectContaining({
        serverId: 'server-1',
        serverName: 'Production',
        remotePath: '/var/www/html/a.txt',
        action: 'upload',
        result: 'success',
        trigger: 'remote-upload',
      }));
      expect(mockHistoryEnforceRetention).toHaveBeenCalledTimes(1);
    });

    it('honours dry run: logs count and destination, transfers nothing, never confirms', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });

      await uploadFilesHere('/var/www/html', dependencies());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        '[remote-upload] DRY RUN — would upload 2 files to /var/www/html (Production)'
      );
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(beaker)'),
        expect.any(Number)
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockHistoryLog).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('continues past a failed upload, aggregates it, logs a failed row, still refreshes', async () => {
      mockConnection.uploadFile
        .mockRejectedValueOnce(new Error('Permission denied'))
        .mockResolvedValue(undefined);

      await uploadFilesHere('/var/www/html', dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('a.txt')
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      const entries = mockHistoryLog.mock.calls[0][0];
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ remotePath: '/var/www/html/a.txt', result: 'failed', error: 'Permission denied' }),
        expect.objectContaining({ remotePath: '/var/www/html/b.txt', result: 'success' }),
      ]));
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('stops at cancellation and reports the remainder', async () => {
      mockConnection.uploadFile.mockImplementation(async () => { cancelRequested = true; });

      await uploadFilesHere('/var/www/html', dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('cancelled')
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 remaining')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('a history failure never masks completed uploads', async () => {
      mockHistoryLog.mockRejectedValue(new Error('disk full'));

      await uploadFilesHere('/var/www/html', dependencies());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 files')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('disk full')
      );
    });
  });

  describe('uploadFolderHere', () => {
    const localFolder = path.join('/home/emo', 'assets');

    beforeEach(() => {
      vscode.window.showOpenDialog.mockResolvedValue([uri(localFolder)]);
      mockWalkLocalTree.mockReturnValue([
        path.join(localFolder, 'logo.png'),
        path.join(localFolder, 'css', 'site.css'),
        path.join(localFolder, 'css', 'vendor', 'reset.css'),
      ]);
    });

    it('opens a single-folder dialog and does nothing when it is dismissed', async () => {
      vscode.window.showOpenDialog.mockResolvedValue(undefined);

      await uploadFolderHere('/var/www/html', dependencies());

      const dialogOptions = vscode.window.showOpenDialog.mock.calls[0][0];
      expect(dialogOptions.canSelectFolders).toBe(true);
      expect(dialogOptions.canSelectFiles).toBe(false);
      expect(dialogOptions.canSelectMany).toBe(false);
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    });

    it('starts the dialog at the workspace root', async () => {
      await uploadFolderHere('/var/www/html', dependencies());

      const dialogOptions = vscode.window.showOpenDialog.mock.calls[0][0];
      expect(dialogOptions.defaultUri).toEqual(
        expect.objectContaining({ fsPath: '/tmp/workspace' })
      );
    });

    it('walks the picked folder with NO skip-list — .git and node_modules are not filtered', async () => {
      await uploadFolderHere('/var/www/html', dependencies());

      expect(mockWalkLocalTree).toHaveBeenCalledWith(localFolder);
    });

    it('confirms with the file count and the remote root under the clicked folder', async () => {
      await uploadFolderHere('/var/www/html', dependencies());

      const [message, options] = vscode.window.showWarningMessage.mock.calls[0];
      expect(message).toContain('3 files');
      expect(message).toContain('/var/www/html/assets');
      expect(options.detail).toContain('bypasses');
      expect(options.detail).toContain('overwritten');
    });

    it('creates the directory skeleton parent-first, then uploads with POSIX remote paths', async () => {
      await uploadFolderHere('/var/www/html', dependencies());

      const createdDirectories = mockConnection.createDirectory.mock.calls.map(call => call[0]);
      expect(createdDirectories).toEqual([
        '/var/www/html/assets',
        '/var/www/html/assets/css',
        '/var/www/html/assets/css/vendor',
      ]);
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(
        path.join(localFolder, 'logo.png'), '/var/www/html/assets/logo.png'
      );
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(
        path.join(localFolder, 'css', 'site.css'), '/var/www/html/assets/css/site.css'
      );
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(
        path.join(localFolder, 'css', 'vendor', 'reset.css'), '/var/www/html/assets/css/vendor/reset.css'
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('tolerates already-existing directories in the skeleton', async () => {
      mockConnection.createDirectory.mockRejectedValue(new Error('File exists'));

      await uploadFolderHere('/var/www/html', dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledTimes(3);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('3 files')
      );
    });

    it('reports an empty folder instead of confirming an upload of nothing', async () => {
      mockWalkLocalTree.mockReturnValue([]);

      await uploadFolderHere('/var/www/html', dependencies());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('no files')
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    });

    it('honours dry run: logs count and remote root, transfers nothing', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });

      await uploadFolderHere('/var/www/html', dependencies());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        '[remote-upload] DRY RUN — would upload 3 files to /var/www/html/assets (Production)'
      );
      expect(mockConnection.createDirectory).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('stops at cancellation and reports the remainder', async () => {
      mockConnection.uploadFile.mockImplementation(async () => { cancelRequested = true; });

      await uploadFolderHere('/var/www/html', dependencies());

      expect(mockConnection.uploadFile).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 remaining')
      );
    });

    it('logs remote-upload history rows for the uploaded files', async () => {
      await uploadFolderHere('/var/www/html', dependencies());

      const entries = mockHistoryLog.mock.calls[0][0];
      expect(entries).toHaveLength(3);
      expect(entries[1]).toEqual(expect.objectContaining({
        remotePath: '/var/www/html/assets/css/site.css',
        trigger: 'remote-upload',
        result: 'success',
      }));
    });

    describe('in a remote window (WSL/SSH — simple dialog has no folder-confirm row)', () => {
      beforeEach(() => {
        (vscode.env as any).remoteName = 'wsl';
        mockPickLocalDirectory.mockResolvedValue(localFolder);
      });

      afterEach(() => {
        (vscode.env as any).remoteName = undefined;
      });

      it('uses the custom local picker starting at the workspace root, not the stock dialog', async () => {
        await uploadFolderHere('/var/www/html', dependencies());

        expect(mockPickLocalDirectory).toHaveBeenCalledWith('/tmp/workspace', expect.stringContaining('/var/www/html'));
        expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
        expect(mockConnection.uploadFile).toHaveBeenCalledTimes(3);
      });

      it('does nothing when the custom picker is dismissed', async () => {
        mockPickLocalDirectory.mockResolvedValue(undefined);

        await uploadFolderHere('/var/www/html', dependencies());

        expect(mockConnection.uploadFile).not.toHaveBeenCalled();
        expect(mockRefresh).not.toHaveBeenCalled();
      });

      it('the files variant keeps the stock dialog even in a remote window', async () => {
        vscode.window.showOpenDialog.mockResolvedValue([uri(path.join('/home/emo/project', 'a.txt'))]);

        await uploadFilesHere('/var/www/html', dependencies());

        expect(vscode.window.showOpenDialog).toHaveBeenCalled();
        expect(mockPickLocalDirectory).not.toHaveBeenCalled();
      });
    });
  });
});
