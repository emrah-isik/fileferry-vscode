jest.mock('../../../services/UploadHistoryService');

import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { createRemoteFolder } from '../../../commands/createRemoteFolder';

const vscode = require('vscode');

const mockConnection = {
  exists: jest.fn(),
  createDirectory: jest.fn(),
};

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
};

const mockOutput = { appendLine: jest.fn() };
const mockRefresh = jest.fn();

const mockHistoryLog = jest.fn();
(UploadHistoryService as unknown as jest.Mock).mockImplementation(() => ({
  log: mockHistoryLog,
  enforceRetention: jest.fn(),
}));

const server = {
  id: 'server-1', type: 'sftp' as const,
  credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/var/www', mappings: [], excludedPaths: [],
};
const baseConfig = { defaultServerId: 'server-1', servers: { Production: server }, dryRun: false };

describe('createRemoteFolder', () => {
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

    vscode.window.showInputBox.mockResolvedValue('uploads');
    vscode.window.withProgress.mockImplementation(
      (_options: any, task: (progress: any) => Promise<any>) => task({ report: jest.fn() })
    );
    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server });
    mockConnection.exists.mockResolvedValue(false);
    mockConnection.createDirectory.mockResolvedValue(undefined);
  });

  it('does nothing when the input box is cancelled', async () => {
    vscode.window.showInputBox.mockResolvedValue(undefined);

    await createRemoteFolder('/var/www', dependencies());

    expect(mockConnection.exists).not.toHaveBeenCalled();
    expect(mockConnection.createDirectory).not.toHaveBeenCalled();
  });

  it('wires the L3 name validator into the input box', async () => {
    await createRemoteFolder('/var/www', dependencies());

    const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
    expect(inputBoxOptions.validateInput('a/b')).toBeTruthy();
    expect(inputBoxOptions.validateInput('a\\b')).toBeTruthy();
    expect(inputBoxOptions.validateInput('.')).toBeTruthy();
    expect(inputBoxOptions.validateInput('')).toBeTruthy();
    expect(inputBoxOptions.validateInput('uploads')).toBeFalsy();
  });

  it('trims the entered name and joins the remote path with POSIX slashes', async () => {
    vscode.window.showInputBox.mockResolvedValue('  uploads  ');

    await createRemoteFolder('/var/www', dependencies());

    expect(mockConnection.createDirectory).toHaveBeenCalledWith('/var/www/uploads');
  });

  it('does not double the slash when creating at the filesystem root', async () => {
    await createRemoteFolder('/', dependencies());

    expect(mockConnection.createDirectory).toHaveBeenCalledWith('/uploads');
  });

  it('honours dryRun: logs, sends nothing, checks nothing (L1)', async () => {
    mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });

    await createRemoteFolder('/var/www', dependencies());

    expect(mockOutput.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('would create /var/www/uploads')
    );
    expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();
    expect(mockConnection.exists).not.toHaveBeenCalled();
    expect(mockConnection.createDirectory).not.toHaveBeenCalled();
  });

  it('shows a visible error and stops when no server is configured', async () => {
    mockConfigManager.getConfig.mockResolvedValue(null);

    await createRemoteFolder('/var/www', dependencies());

    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(mockConnection.createDirectory).not.toHaveBeenCalled();
  });

  describe('collision handling (locked: abort, never merge)', () => {
    it('shows a visible error and aborts when the name already exists', async () => {
      mockConnection.exists.mockResolvedValue(true);

      await createRemoteFolder('/var/www', dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('uploads')
      );
      expect(mockConnection.createDirectory).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('never prompts to merge or overwrite on a collision', async () => {
      mockConnection.exists.mockResolvedValue(true);

      await createRemoteFolder('/var/www', dependencies());

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('surfaces a visible error when the existence check itself fails', async () => {
      mockConnection.exists.mockRejectedValue(new Error('Connection lost'));

      await createRemoteFolder('/var/www', dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection lost')
      );
      expect(mockConnection.createDirectory).not.toHaveBeenCalled();
    });
  });

  describe('the create', () => {
    it('creates the directory and refreshes the panel', async () => {
      await createRemoteFolder('/var/www', dependencies());

      expect(mockConnection.createDirectory).toHaveBeenCalledWith('/var/www/uploads');
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('surfaces a create failure visibly and does not refresh', async () => {
      mockConnection.createDirectory.mockRejectedValue(new Error('Permission denied'));

      await createRemoteFolder('/var/www', dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('never writes a history entry — folder creates are unlogged (L2)', async () => {
      await createRemoteFolder('/var/www', dependencies());

      expect(UploadHistoryService).not.toHaveBeenCalled();
      expect(mockHistoryLog).not.toHaveBeenCalled();
    });
  });
});
