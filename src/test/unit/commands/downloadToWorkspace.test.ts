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

    mockConfigManager.getConfig.mockResolvedValue(configFixture);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: serverFixture });

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockConfigManager as any,
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

    mockConfigManager.getConfig.mockResolvedValue(configFixture);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: serverFixture });

    const saveUri = vscode.Uri.file('/workspace/saved/config.ini');
    (vscode.window as any).showSaveDialog = jest.fn().mockResolvedValue(saveUri);

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockConfigManager as any,
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

    mockConfigManager.getConfig.mockResolvedValue(configFixture);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: serverFixture });

    (vscode.window as any).showSaveDialog = jest.fn().mockResolvedValue(undefined);

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockConfigManager as any,
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

    mockConfigManager.getConfig.mockResolvedValue(configFixture);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: serverFixture });

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockConfigManager as any,
    );

    expect(mockFs.mkdir).toHaveBeenCalledWith('/workspace/deep/nested', { recursive: true });
  });

  it('uses server rootPath for path resolution', async () => {
    const entry: RemoteEntry = {
      name: 'index.php',
      type: '-',
      size: 256,
      modifyTime: 1710000000000,
      remotePath: '/home/deploy/app/index.php',
    };

    const overrideServer = {
      ...serverFixture,
      rootPath: '/home/deploy/app',
      mappings: [{ localPath: '/', remotePath: '' }],
    };
    mockConfigManager.getConfig.mockResolvedValue({
      ...configFixture,
      servers: { Production: overrideServer },
    });
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: overrideServer });

    await downloadToWorkspace(
      entry,
      mockConnection as any,
      mockConfigManager as any,
    );

    expect(mockFs.writeFile).toHaveBeenCalledWith('/workspace/index.php', expect.any(Buffer));
  });
});
