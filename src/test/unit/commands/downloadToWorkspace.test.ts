import * as path from 'path';
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

function makeEntry(overrides: Partial<RemoteEntry> & { name: string; remotePath: string }): RemoteEntry {
  return {
    type: '-',
    size: 1024,
    modifyTime: 1710000000000,
    ...overrides,
  };
}

describe('downloadToWorkspace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.window.withProgress as jest.Mock).mockImplementation(
      (_opts, task) => task({ report: jest.fn() })
    );
    mockConnection.downloadFile.mockResolvedValue(Buffer.from('file content'));
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockConfigManager.getConfig.mockResolvedValue(configFixture);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: serverFixture });
  });

  describe('single target', () => {
    it('downloads file to mapped local path', async () => {
      const entry = makeEntry({ name: 'app.php', remotePath: '/var/www/html/src/app.php' });

      await downloadToWorkspace([entry], mockConnection as any, mockConfigManager as any);

      expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/www/html/src/app.php');
      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join('/workspace', 'src/app.php'), expect.any(Buffer));
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining(path.join('src', 'app.php'))
      );
    });

    it('prompts for save location when no mapping matches', async () => {
      const entry = makeEntry({ name: 'config.ini', size: 512, remotePath: '/other/path/config.ini' });

      const saveUri = vscode.Uri.file('/workspace/saved/config.ini');
      (vscode.window as any).showSaveDialog = jest.fn().mockResolvedValue(saveUri);

      await downloadToWorkspace([entry], mockConnection as any, mockConfigManager as any);

      expect((vscode.window as any).showSaveDialog).toHaveBeenCalled();
      expect(mockFs.writeFile).toHaveBeenCalledWith('/workspace/saved/config.ini', expect.any(Buffer));
    });

    it('does nothing when save dialog is cancelled', async () => {
      const entry = makeEntry({ name: 'config.ini', size: 512, remotePath: '/other/path/config.ini' });

      (vscode.window as any).showSaveDialog = jest.fn().mockResolvedValue(undefined);

      await downloadToWorkspace([entry], mockConnection as any, mockConfigManager as any);

      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('creates parent directories before writing', async () => {
      const entry = makeEntry({ name: 'app.php', remotePath: '/var/www/html/deep/nested/app.php' });

      await downloadToWorkspace([entry], mockConnection as any, mockConfigManager as any);

      expect(mockFs.mkdir).toHaveBeenCalledWith(path.join('/workspace', 'deep/nested'), { recursive: true });
    });

    it('uses server rootPath for path resolution', async () => {
      const entry = makeEntry({ name: 'index.php', size: 256, remotePath: '/home/deploy/app/index.php' });

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

      await downloadToWorkspace([entry], mockConnection as any, mockConfigManager as any);

      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join('/workspace', 'index.php'), expect.any(Buffer));
    });

    it('reports a single failure with the reason', async () => {
      const entry = makeEntry({ name: 'app.php', remotePath: '/var/www/html/src/app.php' });
      mockConnection.downloadFile.mockRejectedValue(new Error('Connection reset'));

      await downloadToWorkspace([entry], mockConnection as any, mockConfigManager as any);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection reset')
      );
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('does nothing when the target list is empty', async () => {
      await downloadToWorkspace([], mockConnection as any, mockConfigManager as any);

      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('multiple targets', () => {
    it('downloads all files under one progress notification and reports the count', async () => {
      const firstEntry = makeEntry({ name: 'a.php', remotePath: '/var/www/html/a.php' });
      const secondEntry = makeEntry({ name: 'b.php', remotePath: '/var/www/html/sub/b.php' });

      await downloadToWorkspace([firstEntry, secondEntry], mockConnection as any, mockConfigManager as any);

      expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
      expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/www/html/a.php');
      expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/www/html/sub/b.php');
      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join('/workspace', 'a.php'), expect.any(Buffer));
      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join('/workspace', 'sub/b.php'), expect.any(Buffer));
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 files')
      );
    });

    it('continues past a failure and aggregates it into one error message', async () => {
      const failingEntry = makeEntry({ name: 'a.php', remotePath: '/var/www/html/a.php' });
      const workingEntry = makeEntry({ name: 'b.php', remotePath: '/var/www/html/b.php' });
      mockConnection.downloadFile
        .mockRejectedValueOnce(new Error('Connection reset'))
        .mockResolvedValueOnce(Buffer.from('content'));

      await downloadToWorkspace([failingEntry, workingEntry], mockConnection as any, mockConfigManager as any);

      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join('/workspace', 'b.php'), expect.any(Buffer));
      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
      const message = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0];
      expect(message).toContain('a.php');
      expect(message).toContain('Connection reset');
    });

    it('skips folders in the selection and says so', async () => {
      const fileEntry = makeEntry({ name: 'a.php', remotePath: '/var/www/html/a.php' });
      const directoryEntry = makeEntry({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/html/logs' });

      await downloadToWorkspace([fileEntry, directoryEntry], mockConnection as any, mockConfigManager as any);

      expect(mockConnection.downloadFile).toHaveBeenCalledTimes(1);
      expect(mockConnection.downloadFile).toHaveBeenCalledWith('/var/www/html/a.php');
      const message = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0][0];
      expect(message).toContain('folder');
    });

    it('treats a cancelled save dialog as a skip, not an error', async () => {
      const unmappedEntry = makeEntry({ name: 'config.ini', size: 512, remotePath: '/other/config.ini' });
      const mappedEntry = makeEntry({ name: 'a.php', remotePath: '/var/www/html/a.php' });

      (vscode.window as any).showSaveDialog = jest.fn().mockResolvedValue(undefined);

      await downloadToWorkspace([unmappedEntry, mappedEntry], mockConnection as any, mockConfigManager as any);

      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join('/workspace', 'a.php'), expect.any(Buffer));
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 file')
      );
    });
  });
});
