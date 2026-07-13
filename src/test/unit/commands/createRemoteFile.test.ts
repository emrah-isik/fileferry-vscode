import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';

jest.mock('fs/promises');
jest.mock('../../../services/UploadHistoryService');
jest.mock('../../../commands/openRemoteFile');

import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { openRemoteFile } from '../../../commands/openRemoteFile';
import { createRemoteFile } from '../../../commands/createRemoteFile';
import { RemoteEditSessionRegistry } from '../../../services/RemoteEditSessionRegistry';

const vscode = require('vscode');

// Test expectations derive from the SAME path calls the source makes — the CI
// matrix runs ubuntu + windows, so a hardcoded separator would break there.
const TEMP_DIR = path.join(os.tmpdir(), 'fileferry-browse');

function expectedTempPath(name: string, remotePath: string): string {
  const hash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
  return path.join(TEMP_DIR, `${name}.create.${hash}`);
}

const mockConnection = {
  exists: jest.fn(),
  uploadFile: jest.fn(),
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

describe('createRemoteFile', () => {
  let registry: RemoteEditSessionRegistry;

  function dependencies() {
    return {
      connection: mockConnection as any,
      configManager: mockConfigManager as any,
      registry,
      output: mockOutput as any,
      refresh: mockRefresh,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new RemoteEditSessionRegistry();

    vscode.window.showInputBox.mockResolvedValue('notes.txt');
    vscode.window.withProgress.mockImplementation(
      (_options: any, task: (progress: any) => Promise<any>) => task({ report: jest.fn() })
    );
    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server });
    mockConnection.exists.mockResolvedValue(false);
    mockConnection.uploadFile.mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
    (openRemoteFile as jest.Mock).mockResolvedValue(undefined);
  });

  it('does nothing when the input box is cancelled', async () => {
    vscode.window.showInputBox.mockResolvedValue(undefined);

    await createRemoteFile('/var/www', dependencies());

    expect(mockConnection.exists).not.toHaveBeenCalled();
    expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    expect(openRemoteFile).not.toHaveBeenCalled();
  });

  it('wires the L3 name validator into the input box', async () => {
    await createRemoteFile('/var/www', dependencies());

    const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
    expect(inputBoxOptions.validateInput('a/b')).toBeTruthy();
    expect(inputBoxOptions.validateInput('a\\b')).toBeTruthy();
    expect(inputBoxOptions.validateInput('..')).toBeTruthy();
    expect(inputBoxOptions.validateInput('   ')).toBeTruthy();
    expect(inputBoxOptions.validateInput('notes.txt')).toBeFalsy();
  });

  it('trims the entered name and joins the remote path with POSIX slashes', async () => {
    vscode.window.showInputBox.mockResolvedValue('  notes.txt  ');

    await createRemoteFile('/var/www', dependencies());

    expect(mockConnection.uploadFile).toHaveBeenCalledWith(
      expect.any(String),
      '/var/www/notes.txt'
    );
  });

  it('does not double the slash when creating at the filesystem root', async () => {
    await createRemoteFile('/', dependencies());

    expect(mockConnection.uploadFile).toHaveBeenCalledWith(
      expect.any(String),
      '/notes.txt'
    );
  });

  it('honours dryRun: logs, sends nothing, checks nothing (L1)', async () => {
    mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });

    await createRemoteFile('/var/www', dependencies());

    expect(mockOutput.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('would create /var/www/notes.txt')
    );
    expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();
    expect(mockConnection.exists).not.toHaveBeenCalled();
    expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    expect(openRemoteFile).not.toHaveBeenCalled();
    expect(mockHistoryLog).not.toHaveBeenCalled();
  });

  it('shows a visible error and stops when no server is configured', async () => {
    mockConfigManager.getConfig.mockResolvedValue(null);

    await createRemoteFile('/var/www', dependencies());

    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(mockConnection.uploadFile).not.toHaveBeenCalled();
  });

  describe('collision handling', () => {
    it('prompts with a modal warning and overwrites when the user confirms', async () => {
      mockConnection.exists.mockResolvedValue(true);
      vscode.window.showWarningMessage.mockResolvedValue('Overwrite');

      await createRemoteFile('/var/www', dependencies());

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('notes.txt'),
        expect.objectContaining({ modal: true }),
        'Overwrite'
      );
      expect(mockConnection.uploadFile).toHaveBeenCalled();
    });

    it('sends nothing when the user cancels the overwrite prompt', async () => {
      mockConnection.exists.mockResolvedValue(true);
      vscode.window.showWarningMessage.mockResolvedValue(undefined);

      await createRemoteFile('/var/www', dependencies());

      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(openRemoteFile).not.toHaveBeenCalled();
      expect(mockHistoryLog).not.toHaveBeenCalled();
    });

    it('surfaces a visible error when the existence check itself fails', async () => {
      mockConnection.exists.mockRejectedValue(new Error('Connection lost'));

      await createRemoteFile('/var/www', dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection lost')
      );
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockHistoryLog).not.toHaveBeenCalled();
    });
  });

  describe('the create upload', () => {
    it('uploads a zero-byte temp file written under fileferry-browse', async () => {
      await createRemoteFile('/var/www', dependencies());

      const tempPath = expectedTempPath('notes.txt', '/var/www/notes.txt');
      expect(fs.mkdir).toHaveBeenCalledWith(TEMP_DIR, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(tempPath, '');
      expect(mockConnection.uploadFile).toHaveBeenCalledWith(tempPath, '/var/www/notes.txt');
    });

    it('removes the temp file afterwards, even when the upload fails', async () => {
      const tempPath = expectedTempPath('notes.txt', '/var/www/notes.txt');

      await createRemoteFile('/var/www', dependencies());
      expect(fs.unlink).toHaveBeenCalledWith(tempPath);

      (fs.unlink as jest.Mock).mockClear();
      mockConnection.uploadFile.mockRejectedValue(new Error('Permission denied'));
      await createRemoteFile('/var/www', dependencies());
      expect(fs.unlink).toHaveBeenCalledWith(tempPath);
    });

    it('logs a remote-create history entry on success (L2)', async () => {
      await createRemoteFile('/var/www', dependencies());

      expect(UploadHistoryService).toHaveBeenCalledWith('/tmp/workspace', 10000);
      expect(mockHistoryLog).toHaveBeenCalledWith([
        expect.objectContaining({
          serverId: 'server-1',
          serverName: 'Production',
          remotePath: '/var/www/notes.txt',
          action: 'upload',
          result: 'success',
          trigger: 'remote-create',
        }),
      ]);
      expect(mockHistoryEnforceRetention).toHaveBeenCalled();
    });

    it('refreshes the panel and opens the new file on the 32a edit-session path', async () => {
      await createRemoteFile('/var/www', dependencies());

      expect(mockRefresh).toHaveBeenCalled();
      expect(openRemoteFile).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'notes.txt',
          type: '-',
          size: 0,
          remotePath: '/var/www/notes.txt',
        }),
        mockConnection,
        registry
      );
    });

    it('surfaces upload failure visibly, logs it as failed, and does not open the file', async () => {
      mockConnection.uploadFile.mockRejectedValue(new Error('Permission denied'));

      await createRemoteFile('/var/www', dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      expect(mockHistoryLog).toHaveBeenCalledWith([
        expect.objectContaining({
          result: 'failed',
          error: 'Permission denied',
          trigger: 'remote-create',
        }),
      ]);
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(openRemoteFile).not.toHaveBeenCalled();
    });

    it('history is best-effort: a history failure never blocks opening the created file', async () => {
      mockHistoryLog.mockRejectedValue(new Error('disk full'));

      await createRemoteFile('/var/www', dependencies());

      expect(openRemoteFile).toHaveBeenCalled();
      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('disk full')
      );
    });

    it('skips history when retention is disabled (historyMaxEntries 0), but still opens the file', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, historyMaxEntries: 0 });

      await createRemoteFile('/var/www', dependencies());

      expect(mockHistoryLog).not.toHaveBeenCalled();
      expect(openRemoteFile).toHaveBeenCalled();
    });
  });
});
