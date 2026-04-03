import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { diffRemoteWithLocal } from '../../../commands/diffRemoteWithLocal';
import { RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

jest.mock('fs/promises');
const mockFs = fs as jest.Mocked<typeof fs>;

const mockConnection = {
  downloadFile: jest.fn(),
  ensureConnected: jest.fn(),
  listDirectory: jest.fn(),
  disconnect: jest.fn(),
  getRootPath: jest.fn().mockReturnValue('/var/www'),
  onDidDisconnect: jest.fn(),
};

const mockBindingManager = {
  getBinding: jest.fn(),
};

const mockServerManager = {
  getServer: jest.fn(),
};

describe('diffRemoteWithLocal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.window.withProgress as jest.Mock).mockImplementation((_opts, task) => task());
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
    mockConnection.downloadFile.mockResolvedValue(Buffer.from('remote content'));
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);

    mockBindingManager.getBinding.mockResolvedValue({
      defaultServerId: 'srv1',
      servers: {
        srv1: {
          mappings: [{ localPath: '/', remotePath: 'html' }],
          excludedPaths: [],
        },
      },
    });
    mockServerManager.getServer.mockResolvedValue({
      id: 'srv1',
      name: 'Production',
      rootPath: '/var/www',
    });
  });

  it('opens diff editor between remote temp file and local file', async () => {
    const entry: RemoteEntry = {
      name: 'app.php',
      type: '-',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/www/html/src/app.php',
    };

    await diffRemoteWithLocal(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any,
    );

    expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/www/html/src/app.php');
    expect(mockFs.writeFile).toHaveBeenCalled();

    // Should open vscode.diff with remote (temp) on left, local on right
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(), // temp file URI
      expect.objectContaining({ fsPath: '/workspace/src/app.php' }), // local file URI
      expect.stringContaining('app.php'),
    );
  });

  it('shows error when local file cannot be resolved', async () => {
    const entry: RemoteEntry = {
      name: 'config.ini',
      type: '-',
      size: 512,
      modifyTime: 1710000000000,
      remotePath: '/other/path/config.ini',
    };

    await diffRemoteWithLocal(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any,
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No local file mapping'),
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('shows error when no binding exists', async () => {
    mockBindingManager.getBinding.mockResolvedValue(null);

    const entry: RemoteEntry = {
      name: 'app.php',
      type: '-',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/www/html/src/app.php',
    };

    await diffRemoteWithLocal(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any,
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No project binding'),
    );
  });

  it('uses rootPathOverride when set', async () => {
    mockBindingManager.getBinding.mockResolvedValue({
      defaultServerId: 'srv1',
      servers: {
        srv1: {
          mappings: [{ localPath: '/', remotePath: '' }],
          excludedPaths: [],
          rootPathOverride: '/home/deploy/app',
        },
      },
    });

    const entry: RemoteEntry = {
      name: 'index.php',
      type: '-',
      size: 256,
      modifyTime: 1710000000000,
      remotePath: '/home/deploy/app/index.php',
    };

    await diffRemoteWithLocal(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any,
    );

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.objectContaining({ fsPath: '/workspace/index.php' }),
      expect.stringContaining('index.php'),
    );
  });
});
