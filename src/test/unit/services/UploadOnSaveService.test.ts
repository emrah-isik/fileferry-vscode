import * as vscode from 'vscode';
import * as child_process from 'child_process';

jest.mock('../../../path/PathResolver');
jest.mock('../../../services/UploadOrchestratorV2');
jest.mock('child_process');

import { PathResolver } from '../../../path/PathResolver';
import { UploadOrchestratorV2 } from '../../../services/UploadOrchestratorV2';
import { UploadOnSaveService } from '../../../services/UploadOnSaveService';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ServerManager } from '../../../storage/ServerManager';
import type { ProjectBindingManager } from '../../../storage/ProjectBindingManager';

const mockResolve = jest.fn();
const mockUpload = jest.fn().mockResolvedValue({ succeeded: [], failed: [], deleted: [], deleteFailed: [] });

(PathResolver as jest.Mock).mockImplementation(() => ({ resolve: mockResolve }));
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

const serverFixture = {
  id: 'srv-1', name: 'Production', type: 'sftp',
  credentialId: 'cred-1', rootPath: '/var/www',
};

const bindingFixture = {
  defaultServerId: 'srv-1',
  uploadOnSave: true,
  servers: {
    'srv-1': {
      mappings: [{ localPath: '/', remotePath: '' }],
      excludedPaths: [],
    },
  },
};

// Capture the onDidSaveTextDocument callback
let saveCallback: (doc: any) => void;
const mockDisposable = { dispose: jest.fn() };

// Mock execFile to simulate git check-ignore
const mockExecFile = child_process.execFile as unknown as jest.Mock;

function deps() {
  return { credentialManager: mockCredentialManager, serverManager: mockServerManager, bindingManager: mockBindingManager };
}

function createService() {
  return new UploadOnSaveService(deps());
}

function makeSavedDoc(fsPath: string) {
  return { uri: { fsPath }, fileName: fsPath };
}

describe('UploadOnSaveService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace.onDidSaveTextDocument as jest.Mock).mockImplementation((cb: any) => {
      saveCallback = cb;
      return mockDisposable;
    });
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(serverFixture);
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(bindingFixture);
    mockResolve.mockReturnValue({ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' });
    mockUpload.mockResolvedValue({
      succeeded: [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }],
      failed: [], deleted: [], deleteFailed: [],
    });
    // Default: file is NOT ignored by git (exit code 1 = not ignored)
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(Object.assign(new Error('not ignored'), { code: 1 }), '', '');
    });
  });

  it('registers an onDidSaveTextDocument listener', () => {
    const service = createService();
    const disposable = service.register();
    expect(vscode.workspace.onDidSaveTextDocument).toHaveBeenCalledWith(expect.any(Function));
    disposable.dispose();
  });

  it('returns a disposable that cleans up the listener', () => {
    const service = createService();
    const disposable = service.register();
    disposable.dispose();
    expect(mockDisposable.dispose).toHaveBeenCalled();
  });

  it('does nothing when uploadOnSave is false', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue({ ...bindingFixture, uploadOnSave: false });
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does nothing when uploadOnSave is undefined', async () => {
    const { uploadOnSave, ...bindingWithout } = bindingFixture;
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(bindingWithout);
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does nothing when no binding exists', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(null);
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does nothing when default server is not found', async () => {
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(undefined);
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does nothing when server binding is missing', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue({
      ...bindingFixture,
      servers: {},
    });
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does nothing when file is outside workspace', async () => {
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/other-project/src/app.php'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does nothing when PathResolver throws (excluded file)', async () => {
    mockResolve.mockImplementation(() => { throw new Error('File is excluded: node_modules/foo.js'); });
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/node_modules/foo.js'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does nothing when no workspace folders exist', async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('uploads the saved file via orchestrator on successful save', async () => {
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(mockUpload).toHaveBeenCalledWith(
      [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }],
      expect.objectContaining({ password: 'secret' }),
      serverFixture,
      [],
    );
  });

  it('shows status bar flash on successful upload', async () => {
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining('app.php'),
      expect.any(Number),
    );
  });

  it('shows error notification on upload failure', async () => {
    mockUpload.mockResolvedValue({
      succeeded: [],
      failed: [{ localPath: '/workspace/src/app.php', error: 'Permission denied' }],
      deleted: [], deleteFailed: [],
    });
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Permission denied'),
    );
  });

  it('shows error notification when orchestrator throws', async () => {
    mockUpload.mockRejectedValue(new Error('Connection refused'));
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/src/app.php'));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Connection refused'),
    );
  });

  it('skips fileferry.json saves to avoid recursive triggers', async () => {
    const service = createService();
    service.register();

    await saveCallback(makeSavedDoc('/workspace/.vscode/fileferry.json'));

    expect(mockUpload).not.toHaveBeenCalled();
  });

  describe('gitignore respect', () => {
    it('does not upload files ignored by git', async () => {
      // exit code 0 = file IS ignored
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, '/workspace/vendor/autoload.php\n', '');
      });
      const service = createService();
      service.register();

      await saveCallback(makeSavedDoc('/workspace/vendor/autoload.php'));

      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('uploads files not ignored by git', async () => {
      const service = createService();
      service.register();

      await saveCallback(makeSavedDoc('/workspace/src/app.php'));

      expect(mockUpload).toHaveBeenCalled();
    });

    it('calls git check-ignore with the correct file path', async () => {
      const service = createService();
      service.register();

      await saveCallback(makeSavedDoc('/workspace/src/app.php'));

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['check-ignore', '-q', '/workspace/src/app.php'],
        { cwd: '/workspace' },
        expect.any(Function),
      );
    });

    it('still uploads when git check-ignore errors unexpectedly', async () => {
      // e.g. git not installed — don't block uploads
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(Object.assign(new Error('git not found'), { code: 127 }), '', '');
      });
      const service = createService();
      service.register();

      await saveCallback(makeSavedDoc('/workspace/src/app.php'));

      expect(mockUpload).toHaveBeenCalled();
    });
  });
});
