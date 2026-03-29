import * as vscode from 'vscode';

// --- Module mocks (hoisted) ---
jest.mock('../../../path/PathResolver');
jest.mock('../../../diffService');

import { PathResolver } from '../../../path/PathResolver';
import { DiffService } from '../../../diffService';
import { showRemoteDiff } from '../../../commands/showRemoteDiff';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ServerManager } from '../../../storage/ServerManager';
import type { ProjectBindingManager } from '../../../storage/ProjectBindingManager';

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

const mockServerManager = {
  getServer: jest.fn(),
} as unknown as ServerManager;

const mockBindingManager = {
  getBinding: jest.fn(),
} as unknown as ProjectBindingManager;

const serverFixture = {
  id: 'srv-1', name: 'Production', type: 'sftp',
  host: 'example.com', port: 22, username: 'deploy',
  authMethod: 'password', credentialId: 'cred-1', rootPath: '/var/www',
};

const bindingFixture = {
  defaultServerId: 'srv-1',
  servers: {
    'srv-1': {
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
    serverManager: mockServerManager,
    bindingManager: mockBindingManager,
  };
}

describe('showRemoteDiff command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockReturnValue({ localPath: '/workspace/src/index.php', remotePath: '/var/www/src/index.php' });
    mockDownloadRemoteFile.mockResolvedValue('/tmp/fileferry/index.remote.a1b2c3d4.php');
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(serverFixture);
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(bindingFixture);
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
    (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.withProgress as any) = jest.fn().mockImplementation(
      (_opts: any, task: (p: any) => Promise<any>) => task({ report: jest.fn() })
    );
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
  });

  it('shows error when no resource is provided', async () => {
    await showRemoteDiff(undefined, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No file selected')
    );
  });

  it('shows error when project binding is missing', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(null);
    await showRemoteDiff(resource, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No project binding')
    );
  });

  it('shows error when default server is not found', async () => {
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(undefined);
    await showRemoteDiff(resource, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Default server not found')
    );
  });

  it('shows error when no server binding exists for the server', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue({
      defaultServerId: 'srv-1',
      servers: {},
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
