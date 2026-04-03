import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { downloadToWorkspace } from '../../../commands/downloadToWorkspace';
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

describe('downloadToWorkspace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.window.withProgress as jest.Mock).mockImplementation((_opts, task) => task());
    mockConnection.downloadFile.mockResolvedValue(Buffer.from('file content'));
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  it('downloads file to mapped local path', async () => {
    const entry: RemoteEntry = {
      name: 'app.php',
      type: '-',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/www/html/src/app.php',
    };

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

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any
    );

    expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/www/html/src/app.php');
    expect(mockFs.writeFile).toHaveBeenCalledWith('/workspace/src/app.php', expect.any(Buffer));
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('src/app.php')
    );
  });

  it('prompts for save location when no mapping matches', async () => {
    const entry: RemoteEntry = {
      name: 'config.ini',
      type: '-',
      size: 512,
      modifyTime: 1710000000000,
      remotePath: '/other/path/config.ini',
    };

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

    const saveUri = vscode.Uri.file('/workspace/saved/config.ini');
    (vscode.window as any).showSaveDialog = jest.fn().mockResolvedValue(saveUri);

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any,
    );

    expect((vscode.window as any).showSaveDialog).toHaveBeenCalled();
    expect(mockFs.writeFile).toHaveBeenCalledWith('/workspace/saved/config.ini', expect.any(Buffer));
  });

  it('does nothing when save dialog is cancelled', async () => {
    const entry: RemoteEntry = {
      name: 'config.ini',
      type: '-',
      size: 512,
      modifyTime: 1710000000000,
      remotePath: '/other/path/config.ini',
    };

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

    (vscode.window as any).showSaveDialog = jest.fn().mockResolvedValue(undefined);

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any,
    );

    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('creates parent directories before writing', async () => {
    const entry: RemoteEntry = {
      name: 'app.php',
      type: '-',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/www/html/deep/nested/app.php',
    };

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

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any,
    );

    expect(mockFs.mkdir).toHaveBeenCalledWith('/workspace/deep/nested', { recursive: true });
  });

  it('uses rootPathOverride when set', async () => {
    const entry: RemoteEntry = {
      name: 'index.php',
      type: '-',
      size: 256,
      modifyTime: 1710000000000,
      remotePath: '/home/deploy/app/index.php',
    };

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
    mockServerManager.getServer.mockResolvedValue({
      id: 'srv1',
      name: 'Production',
      rootPath: '/var/www',
    });

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockBindingManager as any,
      mockServerManager as any,
    );

    expect(mockFs.writeFile).toHaveBeenCalledWith('/workspace/index.php', expect.any(Buffer));
  });
});
