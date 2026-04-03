import { openRemoteFile } from '../../../commands/openRemoteFile';
import { RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';
import * as fs from 'fs/promises';

const vscode = require('vscode');

jest.mock('fs/promises');

const mockConnection = {
  downloadFile: jest.fn(),
  ensureConnected: jest.fn(),
};

const entry: RemoteEntry = {
  name: 'error.log',
  type: '-',
  size: 2048,
  modifyTime: 1710100000000,
  remotePath: '/var/log/error.log',
};

describe('openRemoteFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

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

    await openRemoteFile(entry, mockConnection as any);

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

    await openRemoteFile(entry, mockConnection as any);
    const firstPath = (fs.writeFile as jest.Mock).mock.calls[0][0];

    (fs.writeFile as jest.Mock).mockClear();
    await openRemoteFile(entry, mockConnection as any);
    const secondPath = (fs.writeFile as jest.Mock).mock.calls[0][0];

    expect(firstPath).toBe(secondPath);
  });

  it('shows progress during download', async () => {
    mockConnection.downloadFile.mockResolvedValue(Buffer.from('content'));

    await openRemoteFile(entry, mockConnection as any);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        location: vscode.ProgressLocation.Window,
      }),
      expect.any(Function)
    );
  });

  it('shows error message on download failure', async () => {
    mockConnection.downloadFile.mockRejectedValue(new Error('Network error'));

    await openRemoteFile(entry, mockConnection as any);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Network error')
    );
  });
});
