import * as crypto from 'crypto';
import { openRemoteFile } from '../../../commands/openRemoteFile';
import { RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';
import { RemoteEditSessionRegistry } from '../../../services/RemoteEditSessionRegistry';
import * as fs from 'fs/promises';

const vscode = require('vscode');

jest.mock('fs/promises');

const mockConnection = {
  downloadFile: jest.fn(),
  ensureConnected: jest.fn(),
  statRemote: jest.fn(),
  getCurrentServerId: jest.fn(),
};

const entry: RemoteEntry = {
  name: 'error.log',
  type: '-',
  size: 2048,
  modifyTime: 1710100000000,
  remotePath: '/var/log/error.log',
};

describe('openRemoteFile', () => {
  let registry: RemoteEditSessionRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new RemoteEditSessionRegistry();
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    mockConnection.statRemote.mockResolvedValue({ mtime: new Date('2026-07-12T10:00:00Z') });
    mockConnection.getCurrentServerId.mockReturnValue('server-1');

    // Mock withProgress to immediately call the callback
    vscode.window.withProgress.mockImplementation(
      (_opts: any, task: (progress: any) => Promise<any>) =>
        task({ report: jest.fn() })
    );

    // Mock openTextDocument and showTextDocument
    const fakeDoc = { uri: { fsPath: '/tmp/test' } };
    vscode.workspace.openTextDocument = jest.fn().mockResolvedValue(fakeDoc);
    vscode.window.showTextDocument = jest.fn().mockResolvedValue(undefined);
  });

  it('downloads file and opens in editor', async () => {
    const content = Buffer.from('error log content');
    mockConnection.downloadFile.mockResolvedValue(content);

    await openRemoteFile(entry, mockConnection as any, registry);

    expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/log/error.log');
    expect(fs.mkdir).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/error\.remote\.\w+\.log$/),
      content
    );
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preview: true })
    );
  });

  it('produces deterministic temp paths for the same remote path', async () => {
    mockConnection.downloadFile.mockResolvedValue(Buffer.from('content'));

    await openRemoteFile(entry, mockConnection as any, registry);
    const firstPath = (fs.writeFile as jest.Mock).mock.calls[0][0];

    (fs.writeFile as jest.Mock).mockClear();
    await openRemoteFile(entry, mockConnection as any, registry);
    const secondPath = (fs.writeFile as jest.Mock).mock.calls[0][0];

    expect(firstPath).toBe(secondPath);
  });

  it('shows progress during download', async () => {
    mockConnection.downloadFile.mockResolvedValue(Buffer.from('content'));

    await openRemoteFile(entry, mockConnection as any, registry);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        location: vscode.ProgressLocation.Window,
      }),
      expect.any(Function)
    );
  });

  it('shows error message on download failure', async () => {
    mockConnection.downloadFile.mockRejectedValue(new Error('Network error'));

    await openRemoteFile(entry, mockConnection as any, registry);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Network error')
    );
  });

  describe('edit session registration (feature 32a)', () => {
    it('registers a session keyed by the opened document path', async () => {
      const content = Buffer.from('error log content');
      const remoteMtime = new Date('2026-07-12T10:00:00Z');
      mockConnection.downloadFile.mockResolvedValue(content);
      mockConnection.statRemote.mockResolvedValue({ mtime: remoteMtime });

      await openRemoteFile(entry, mockConnection as any, registry);

      // Keyed by doc.uri.fsPath (VS Code's normalised form), not the raw temp path
      expect(registry.get('/tmp/test')).toEqual({
        serverId: 'server-1',
        remotePath: '/var/log/error.log',
        downloadedMtimeMs: remoteMtime.getTime(),
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      });
    });

    it('stats the remote before downloading, so a change in the window reads as a conflict', async () => {
      mockConnection.downloadFile.mockResolvedValue(Buffer.from('content'));

      await openRemoteFile(entry, mockConnection as any, registry);

      const statOrder = mockConnection.statRemote.mock.invocationCallOrder[0];
      const downloadOrder = mockConnection.downloadFile.mock.invocationCallOrder[0];
      expect(statOrder).toBeLessThan(downloadOrder);
    });

    it('registers a NaN baseline when the remote cannot be statted (save will fail closed)', async () => {
      mockConnection.downloadFile.mockResolvedValue(Buffer.from('content'));
      mockConnection.statRemote.mockResolvedValue(null);

      await openRemoteFile(entry, mockConnection as any, registry);

      expect(Number.isNaN(registry.get('/tmp/test')?.downloadedMtimeMs)).toBe(true);
      expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    it('still opens the file and registers a NaN baseline when stat throws', async () => {
      mockConnection.downloadFile.mockResolvedValue(Buffer.from('content'));
      mockConnection.statRemote.mockRejectedValue(new Error('stat not supported'));

      await openRemoteFile(entry, mockConnection as any, registry);

      expect(vscode.window.showTextDocument).toHaveBeenCalled();
      expect(Number.isNaN(registry.get('/tmp/test')?.downloadedMtimeMs)).toBe(true);
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('does not register and warns when no server id is available', async () => {
      mockConnection.downloadFile.mockResolvedValue(Buffer.from('content'));
      mockConnection.getCurrentServerId.mockReturnValue(null);

      await openRemoteFile(entry, mockConnection as any, registry);

      expect(registry.get('/tmp/test')).toBeUndefined();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('will not upload')
      );
    });

    it('registers nothing when the download fails', async () => {
      mockConnection.downloadFile.mockRejectedValue(new Error('Network error'));

      await openRemoteFile(entry, mockConnection as any, registry);

      expect(registry.get('/tmp/test')).toBeUndefined();
    });
  });
});
