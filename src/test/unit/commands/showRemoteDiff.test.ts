import * as vscode from 'vscode';

// --- Module mocks (hoisted) ---
jest.mock('../../../path/PathResolver');
jest.mock('../../../diffService');

import { PathResolver } from '../../../path/PathResolver';
import { DiffService } from '../../../diffService';
import { showRemoteDiff } from '../../../commands/showRemoteDiff';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockResolve = jest.fn();
const mockDownloadRemoteFile = jest.fn();

(PathResolver as jest.Mock).mockImplementation(() => ({ resolve: mockResolve }));
(DiffService as jest.Mock).mockImplementation(() => ({ downloadRemoteFile: mockDownloadRemoteFile }));

const mockCredentialManager = {
  getWithSecret: jest.fn().mockResolvedValue({
    id: 'cred-1', host: 'example.com', port: 22,
    username: 'deploy', authMethod: 'password', password: 'secret',
  }),
} as unknown as CredentialManager;

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
  toggleUploadOnSave: jest.fn(),
} as unknown as ProjectConfigManager;

const serverFixture = {
  id: 'srv-1', type: 'sftp',
  credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: '' }],
  excludedPaths: [],
};

const configFixture = {
  defaultServerId: 'srv-1',
  uploadOnSave: false,
  servers: {
    Production: {
      id: 'srv-1',
      type: 'sftp',
      credentialId: 'cred-1',
      credentialName: 'deploy@prod',
      rootPath: '/var/www',
      mappings: [{ localPath: '/', remotePath: '' }],
      excludedPaths: [],
    },
  },
};

const resource = {
  resourceUri: vscode.Uri.file('/workspace/src/index.php'),
} as vscode.SourceControlResourceState;

function deps() {
  return {
    credentialManager: mockCredentialManager,
    configManager: mockConfigManager,
  };
}

describe('showRemoteDiff command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockReturnValue({ localPath: '/workspace/src/index.php', remotePath: '/var/www/src/index.php' });
    mockDownloadRemoteFile.mockResolvedValue('/tmp/fileferry/index.remote.a1b2c3d4.php');
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configFixture);
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue({ name: 'Production', server: serverFixture });
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
    (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.withProgress as any) = jest.fn().mockImplementation(
      (_opts: any, task: (p: any) => Promise<any>) => task({ report: jest.fn() })
    );
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
  });

  it('shows error when no resource is provided and no active editor', async () => {
    (vscode.window as any).activeTextEditor = undefined;
    await showRemoteDiff(undefined, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No file selected')
    );
  });

  it('uses activeTextEditor URI when called with no resource arg', async () => {
    (vscode.window as any).activeTextEditor = {
      document: { uri: vscode.Uri.file('/workspace/src/index.php') },
    };

    await showRemoteDiff(undefined, deps());

    expect(mockResolve).toHaveBeenCalledWith(
      '/workspace/src/index.php',
      expect.any(String),
      expect.any(Object)
    );
    expect(mockDownloadRemoteFile).toHaveBeenCalled();
  });

  it('shows error when project configuration is missing', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(null);
    await showRemoteDiff(resource, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No project configuration found')
    );
  });

  it('shows error when default server is not found', async () => {
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue(undefined);
    await showRemoteDiff(resource, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Default server not found')
    );
  });

  it('shows error when no mappings exist for the server', async () => {
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue({
      name: 'Production',
      server: { ...serverFixture, mappings: [] },
    });
    await showRemoteDiff(resource, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No mappings')
    );
  });

  it('shows error when PathResolver cannot find a mapping', async () => {
    mockResolve.mockImplementation(() => { throw new Error('No mapping found for: /workspace/src/index.php'); });
    await showRemoteDiff(resource, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No mapping found')
    );
  });

  it('shows progress notification while downloading', async () => {
    await showRemoteDiff(resource, deps());
    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ location: vscode.ProgressLocation.Notification }),
      expect.any(Function)
    );
  });

  it('downloads remote file via DiffService', async () => {
    await showRemoteDiff(resource, deps());
    expect(mockDownloadRemoteFile).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'example.com' }),
      expect.objectContaining({ password: 'secret' }),
      '/var/www/src/index.php'
    );
  });

  it('opens VSCode diff editor with local and remote URIs', async () => {
    await showRemoteDiff(resource, deps());
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ fsPath: '/tmp/fileferry/index.remote.a1b2c3d4.php' }),
      expect.objectContaining({ fsPath: '/workspace/src/index.php' }),
      expect.stringContaining('index.php')
    );
  });

  it('includes server name in the diff editor title', async () => {
    await showRemoteDiff(resource, deps());
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.stringContaining('Production')
    );
  });

  it('shows error when remote file download fails', async () => {
    mockDownloadRemoteFile.mockRejectedValue(new Error('No such file'));
    await showRemoteDiff(resource, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No such file')
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
