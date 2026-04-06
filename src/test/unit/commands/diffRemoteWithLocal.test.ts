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

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
  toggleUploadOnSave: jest.fn(),
};

const serverFixture = {
  id: 'srv1',
  type: 'sftp',
  credentialId: 'cred-1',
  credentialName: 'deploy@prod',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: 'html' }],
  excludedPaths: [],
};

const configFixture = {
  defaultServerId: 'srv1',
  uploadOnSave: false,
  servers: {
    Production: {
      id: 'srv1',
      type: 'sftp',
      credentialId: 'cred-1',
      credentialName: 'deploy@prod',
      rootPath: '/var/www',
      mappings: [{ localPath: '/', remotePath: 'html' }],
      excludedPaths: [],
    },
  },
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

    mockConfigManager.getConfig.mockResolvedValue(configFixture);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: serverFixture });
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
      mockConfigManager as any,
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
      mockConfigManager as any,
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No local file mapping'),
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('shows error when no configuration exists', async () => {
    mockConfigManager.getConfig.mockResolvedValue(null);

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
      mockConfigManager as any,
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No project configuration found'),
    );
  });

  it('uses rootPath override when server has different rootPath', async () => {
    const overrideServer = {
      ...serverFixture,
      rootPath: '/home/deploy/app',
      mappings: [{ localPath: '/', remotePath: '' }],
    };
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: overrideServer });

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
      mockConfigManager as any,
    );

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.objectContaining({ fsPath: '/workspace/index.php' }),
      expect.stringContaining('index.php'),
    );
  });
});
