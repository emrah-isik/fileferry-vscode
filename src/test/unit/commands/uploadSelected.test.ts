import * as vscode from 'vscode';

// --- Module mocks (hoisted) ---
jest.mock('../../../scm/ScmResourceResolver');
jest.mock('../../../path/PathResolver');
jest.mock('../../../services/UploadOrchestratorV2');

import { ScmResourceResolver } from '../../../scm/ScmResourceResolver';
import { PathResolver } from '../../../path/PathResolver';
import { UploadOrchestratorV2 } from '../../../services/UploadOrchestratorV2';
import { uploadSelected } from '../../../commands/uploadSelected';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ServerManager } from '../../../storage/ServerManager';
import type { ProjectBindingManager } from '../../../storage/ProjectBindingManager';

const mockResolve = jest.fn();
const mockResolveAll = jest.fn();
const mockUpload = jest.fn().mockResolvedValue({ succeeded: [], failed: [], deleted: [], deleteFailed: [] });

(ScmResourceResolver as jest.Mock).mockImplementation(() => ({ resolve: mockResolve }));
(PathResolver as jest.Mock).mockImplementation(() => ({ resolveAll: mockResolveAll }));
(UploadOrchestratorV2 as jest.Mock).mockImplementation(() => ({ upload: mockUpload }));

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

const mockContext = {
  globalState: { get: jest.fn().mockReturnValue(false), update: jest.fn() },
} as unknown as vscode.ExtensionContext;

const serverFixture = {
  id: 'srv-1', name: 'Production', type: 'sftp',
  credentialId: 'cred-1', rootPath: '/var/www',
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

const resource = { resourceUri: vscode.Uri.file('/workspace/src/app.php') } as any;

function deps() {
  return { credentialManager: mockCredentialManager, serverManager: mockServerManager, bindingManager: mockBindingManager, context: mockContext };
}

describe('uploadSelected command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockReturnValue({ toUpload: ['/workspace/src/app.php'], toDelete: [] });
    mockResolveAll.mockReturnValue([{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }]);
    mockUpload.mockResolvedValue({ succeeded: [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }], failed: [], deleted: [], deleteFailed: [] });
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(serverFixture);
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(bindingFixture);
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Upload');
    (vscode.window.withProgress as any) = jest.fn().mockImplementation(
      (_opts: any, task: (p: any) => Promise<any>) => task({ report: jest.fn() })
    );
  });

  it('shows warning when no files are resolved (toUpload and toDelete both empty)', async () => {
    mockResolve.mockReturnValue({ toUpload: [], toDelete: [] });
    await uploadSelected(resource, undefined, deps());
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No files selected')
    );
  });

  it('shows error when project binding is missing', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(null);
    await uploadSelected(resource, undefined, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No project binding')
    );
  });

  it('shows error when default server is not found', async () => {
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(undefined);
    await uploadSelected(resource, undefined, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Default server not found')
    );
  });

  it('cancels upload when user dismisses confirmation', async () => {
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Cancel');
    await uploadSelected(resource, undefined, deps());
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('calls UploadOrchestratorV2 with resolved upload items', async () => {
    await uploadSelected(resource, undefined, deps());
    expect(mockUpload).toHaveBeenCalledWith(
      [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }],
      expect.objectContaining({ password: 'secret' }),
      serverFixture,
      []
    );
  });

  it('shows success notification after upload', async () => {
    await uploadSelected(resource, undefined, deps());
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('1 file')
    );
  });

  it('shows partial-failure notification when some files fail', async () => {
    mockUpload.mockResolvedValue({
      succeeded: [],
      failed: [{ localPath: '/workspace/src/app.php', error: 'Permission denied' }],
      deleted: [],
      deleteFailed: [],
    });
    await uploadSelected(resource, undefined, deps());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('1 file'),
      expect.any(String)
    );
  });

  describe('deletion flow', () => {
    beforeEach(() => {
      mockResolve.mockReturnValue({
        toUpload: [],
        toDelete: ['/workspace/src/deleted.php'],
      });
      mockResolveAll
        .mockReturnValueOnce([]) // upload items
        .mockReturnValueOnce([{ localPath: '/workspace/src/deleted.php', remotePath: '/var/www/src/deleted.php' }]); // delete items
      mockUpload.mockResolvedValue({ succeeded: [], failed: [], deleted: ['/var/www/src/deleted.php'], deleteFailed: [] });
      // confirmWithDeletions uses showInformationMessage — return 'Proceed'
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Proceed');
    });

    it('passes remote delete paths to orchestrator', async () => {
      await uploadSelected(resource, undefined, deps());
      expect(mockUpload).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ password: 'secret' }),
        serverFixture,
        ['/var/www/src/deleted.php']
      );
    });

    it('always shows confirmation dialog when deletions present, even if suppressed', async () => {
      (mockContext.globalState.get as jest.Mock).mockReturnValue(true); // upload suppressed
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Proceed');
      await uploadSelected(resource, undefined, deps());
      expect(vscode.window.showInformationMessage).toHaveBeenCalled();
      expect(mockUpload).toHaveBeenCalled();
    });

    it('cancels when user declines deletion confirmation', async () => {
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Cancel');
      await uploadSelected(resource, undefined, deps());
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('shows error notification when deletions fail', async () => {
      mockUpload.mockResolvedValue({
        succeeded: [], failed: [], deleted: [],
        deleteFailed: [{ remotePath: '/var/www/src/deleted.php', error: 'Permission denied' }],
      });
      await uploadSelected(resource, undefined, deps());
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 file'),
        expect.any(String)
      );
    });

    it('shows success notification when all deletions succeed', async () => {
      mockUpload.mockResolvedValue({
        succeeded: [], failed: [], deleted: ['/var/www/src/deleted.php'], deleteFailed: [],
      });
      await uploadSelected(resource, undefined, deps());
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('deleted')
      );
    });
  });
});
