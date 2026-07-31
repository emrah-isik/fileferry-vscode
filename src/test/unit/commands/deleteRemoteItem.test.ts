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

function makeItem(overrides: Partial<RemoteEntry> & { name: string; remotePath: string }): RemoteFileItem {
  const entry: RemoteEntry = {
    type: '-',
    size: 1024,
    modifyTime: 1710000000000,
    ...overrides,
  };
  return new RemoteFileItem(entry);
}

describe('deleteRemoteItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.deleteRemoteFile.mockResolvedValue(undefined);
    mockConnection.deleteRemoteDirectory.mockResolvedValue(undefined);
  });

  describe('single target', () => {
    it('deletes a file after confirmation', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

      const item = makeItem({ name: 'old.php', remotePath: '/var/www/old.php' });

      await deleteRemoteItem([item], mockConnection as any, mockRefresh);

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

      const item = makeItem({ name: 'old-folder', type: 'd', size: 4096, remotePath: '/var/www/old-folder' });

      await deleteRemoteItem([item], mockConnection as any, mockRefresh);

      expect(mockConnection.deleteRemoteDirectory).toHaveBeenCalledWith('/var/www/old-folder');
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('does nothing when user cancels confirmation', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

      const item = makeItem({ name: 'important.php', remotePath: '/var/www/important.php' });

      await deleteRemoteItem([item], mockConnection as any, mockRefresh);

      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('deletes a symlink-to-directory with deleteFile (removes link, not target)', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

      const item = makeItem({
        name: 'current',
        type: 'l',
        size: 11,
        remotePath: '/var/www/current',
        symlinkTarget: 'd',
      });

      await deleteRemoteItem([item], mockConnection as any, mockRefresh);

      expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/current');
      expect(mockConnection.deleteRemoteDirectory).not.toHaveBeenCalled();
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('shows error on failure and does not refresh when nothing was deleted', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
      mockConnection.deleteRemoteFile.mockRejectedValue(new Error('Permission denied'));

      const item = makeItem({ name: 'protected.php', remotePath: '/var/www/protected.php' });

      await deleteRemoteItem([item], mockConnection as any, mockRefresh);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied'),
      );
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('does nothing when the target list is empty', async () => {
      await deleteRemoteItem([], mockConnection as any, mockRefresh);

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
      expect(mockConnection.deleteRemoteDirectory).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('multiple targets', () => {
    it('confirms once with the exact count, deletes sequentially, refreshes once', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

      const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
      const directoryItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });
      const otherFileItem = makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });

      await deleteRemoteItem([fileItem, directoryItem, otherFileItem], mockConnection as any, mockRefresh);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Delete 3 items from the server?',
        expect.objectContaining({ modal: true }),
        'Delete',
      );
      expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/a.txt');
      expect(mockConnection.deleteRemoteDirectory).toHaveBeenCalledWith('/var/www/logs');
      expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/b.txt');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the user cancels the multi-item confirmation', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

      const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
      const otherFileItem = makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });

      await deleteRemoteItem([fileItem, otherFileItem], mockConnection as any, mockRefresh);

      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('drops a selected child of a selected folder: count stays honest, child never deleted', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

      const directoryItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });
      const childItem = makeItem({ name: 'app.log', remotePath: '/var/www/logs/app.log' });
      const unrelatedItem = makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });

      await deleteRemoteItem([directoryItem, childItem, unrelatedItem], mockConnection as any, mockRefresh);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Delete 2 items from the server?',
        expect.objectContaining({ modal: true }),
        'Delete',
      );
      expect(mockConnection.deleteRemoteDirectory).toHaveBeenCalledWith('/var/www/logs');
      expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/b.txt');
      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalledWith('/var/www/logs/app.log');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('uses the single-item wording when dedupe reduces the selection to one entry', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

      const directoryItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });
      const childItem = makeItem({ name: 'app.log', remotePath: '/var/www/logs/app.log' });

      await deleteRemoteItem([directoryItem, childItem], mockConnection as any, mockRefresh);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('folder "logs"'),
        expect.objectContaining({ modal: true }),
        'Delete',
      );
      expect(mockConnection.deleteRemoteDirectory).toHaveBeenCalledWith('/var/www/logs');
      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
    });

    it('continues past a failure, aggregates it into one message, still refreshes once', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
      mockConnection.deleteRemoteFile
        .mockRejectedValueOnce(new Error('Permission denied'))
        .mockResolvedValueOnce(undefined);

      const protectedItem = makeItem({ name: 'protected.php', remotePath: '/var/www/protected.php' });
      const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });

      await deleteRemoteItem([protectedItem, fileItem], mockConnection as any, mockRefresh);

      expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/a.txt');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('protected.php'),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied'),
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('aggregates several failures into a single message naming each item', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
      mockConnection.deleteRemoteFile.mockRejectedValue(new Error('Permission denied'));
      mockConnection.deleteRemoteDirectory.mockRejectedValue(new Error('Directory not empty'));

      const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
      const directoryItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });

      await deleteRemoteItem([fileItem, directoryItem], mockConnection as any, mockRefresh);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
      const message = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0];
      expect(message).toContain('a.txt');
      expect(message).toContain('Permission denied');
      expect(message).toContain('logs');
      expect(message).toContain('Directory not empty');
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });
});
