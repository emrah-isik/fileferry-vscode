import * as vscode from 'vscode';
import { deleteRemoteItem } from '../../../commands/deleteRemoteItem';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

const mockConnection = {
  deleteRemoteFile: jest.fn(),
  deleteRemoteDirectory: jest.fn(),
  ensureConnected: jest.fn(),
  listDirectory: jest.fn(),
  downloadFile: jest.fn(),
  disconnect: jest.fn(),
  getRootPath: jest.fn().mockReturnValue('/var/www'),
  onDidDisconnect: jest.fn(),
};

const mockRefresh = jest.fn();

describe('deleteRemoteItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.deleteRemoteFile.mockResolvedValue(undefined);
    mockConnection.deleteRemoteDirectory.mockResolvedValue(undefined);
  });

  it('deletes a file after confirmation', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

    const entry: RemoteEntry = {
      name: 'old.php',
      type: '-',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/www/old.php',
    };
    const item = new RemoteFileItem(entry);

    await deleteRemoteItem(item, mockConnection as any, mockRefresh);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('old.php'),
      expect.objectContaining({ modal: true }),
      'Delete',
    );
    expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/old.php');
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('deletes a directory after confirmation', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

    const entry: RemoteEntry = {
      name: 'old-folder',
      type: 'd',
      size: 4096,
      modifyTime: 1710000000000,
      remotePath: '/var/www/old-folder',
    };
    const item = new RemoteFileItem(entry);

    await deleteRemoteItem(item, mockConnection as any, mockRefresh);

    expect(mockConnection.deleteRemoteDirectory).toHaveBeenCalledWith('/var/www/old-folder');
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('does nothing when user cancels confirmation', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const entry: RemoteEntry = {
      name: 'important.php',
      type: '-',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/www/important.php',
    };
    const item = new RemoteFileItem(entry);

    await deleteRemoteItem(item, mockConnection as any, mockRefresh);

    expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows error on failure', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
    mockConnection.deleteRemoteFile.mockRejectedValue(new Error('Permission denied'));

    const entry: RemoteEntry = {
      name: 'protected.php',
      type: '-',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/www/protected.php',
    };
    const item = new RemoteFileItem(entry);

    await deleteRemoteItem(item, mockConnection as any, mockRefresh);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Permission denied'),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
