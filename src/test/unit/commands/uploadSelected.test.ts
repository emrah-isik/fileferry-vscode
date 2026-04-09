import * as vscode from 'vscode';

// --- Module mocks (hoisted) ---
jest.mock('../../../scm/ScmResourceResolver');
jest.mock('../../../path/PathResolver');
jest.mock('../../../services/UploadOrchestratorV2');
jest.mock('../../../services/FileDateGuard');
jest.mock('../../../services/BackupService');
jest.mock('../../../services/DryRunReporter');

import { ScmResourceResolver } from '../../../scm/ScmResourceResolver';
import { PathResolver } from '../../../path/PathResolver';
import { UploadOrchestratorV2 } from '../../../services/UploadOrchestratorV2';
import { FileDateGuard } from '../../../services/FileDateGuard';
import { BackupService } from '../../../services/BackupService';
import { DryRunReporter } from '../../../services/DryRunReporter';
import { uploadSelected } from '../../../commands/uploadSelected';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockResolve = jest.fn();
const mockResolveAll = jest.fn();
const mockUpload = jest.fn().mockResolvedValue({ succeeded: [], failed: [], deleted: [], deleteFailed: [] });
const mockDateGuardCheck = jest.fn().mockResolvedValue([]);
const mockBackup = jest.fn().mockResolvedValue(undefined);
const mockCleanup = jest.fn().mockResolvedValue(undefined);
const mockDryRunReport = jest.fn();

(ScmResourceResolver as jest.Mock).mockImplementation(() => ({ resolve: mockResolve }));
(PathResolver as jest.Mock).mockImplementation(() => ({ resolveAll: mockResolveAll }));
(UploadOrchestratorV2 as jest.Mock).mockImplementation(() => ({ upload: mockUpload }));
(FileDateGuard as jest.Mock).mockImplementation(() => ({ check: mockDateGuardCheck }));
(BackupService as jest.Mock).mockImplementation(() => ({ backup: mockBackup, cleanup: mockCleanup }));
(DryRunReporter as jest.Mock).mockImplementation(() => ({ report: mockDryRunReport }));

const mockCredentialManager = {
  getWithSecret: jest.fn().mockResolvedValue({
    id: 'cred-1', host: 'example.com', port: 22,
    username: 'deploy', authMethod: 'password', password: 'secret',
  }),
} as unknown as CredentialManager;

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
} as unknown as ProjectConfigManager;

const mockContext = {
  globalState: { get: jest.fn().mockReturnValue(false), update: jest.fn() },
} as unknown as vscode.ExtensionContext;

const mockOutput = {
  appendLine: jest.fn(),
  show: jest.fn(),
} as unknown as vscode.OutputChannel;

const serverFixture = {
  id: 'srv-1',
  type: 'sftp',
  credentialId: 'cred-1',
  credentialName: 'deploy@prod',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: '' }],
  excludedPaths: [],
};

const configFixture = {
  defaultServerId: 'srv-1',
  uploadOnSave: false,
  servers: {
    Production: serverFixture,
  },
};

const resource = { resourceUri: vscode.Uri.file('/workspace/src/app.php') } as any;

function dependencies() {
  return { credentialManager: mockCredentialManager, configManager: mockConfigManager, context: mockContext, output: mockOutput };
}

describe('uploadSelected command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDateGuardCheck.mockResolvedValue([]);
    mockResolve.mockReturnValue({ toUpload: ['/workspace/src/app.php'], toDelete: [] });
    mockResolveAll.mockReturnValue([{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }]);
    mockUpload.mockResolvedValue({ succeeded: [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }], failed: [], deleted: [], deleteFailed: [] });
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configFixture);
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue({ name: 'Production', server: serverFixture });
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Upload');
    (vscode.window.withProgress as any) = jest.fn().mockImplementation(
      (_opts: any, task: (p: any, token: any) => Promise<any>) => task({ report: jest.fn() }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })
    );
  });

  it('shows warning when no files are resolved (toUpload and toDelete both empty)', async () => {
    mockResolve.mockReturnValue({ toUpload: [], toDelete: [] });
    await uploadSelected(resource, undefined, dependencies());
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No files selected')
    );
  });

  it('shows error when project config is missing', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(null);
    await uploadSelected(resource, undefined, dependencies());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No project configuration')
    );
  });

  it('shows error when default server is not found', async () => {
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue(undefined);
    await uploadSelected(resource, undefined, dependencies());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Default server not found')
    );
  });

  it('cancels upload when user dismisses confirmation', async () => {
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Cancel');
    await uploadSelected(resource, undefined, dependencies());
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('calls UploadOrchestratorV2 with resolved upload items', async () => {
    await uploadSelected(resource, undefined, dependencies());
    expect(mockUpload).toHaveBeenCalledWith(
      [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }],
      expect.objectContaining({ password: 'secret' }),
      expect.any(Object),
      [],
      expect.objectContaining({ isCancellationRequested: false })
    );
  });

  it('shows success notification after upload', async () => {
    await uploadSelected(resource, undefined, dependencies());
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
    await uploadSelected(resource, undefined, dependencies());
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
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Proceed');
    });

    it('passes remote delete paths to orchestrator', async () => {
      await uploadSelected(resource, undefined, dependencies());
      expect(mockUpload).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ password: 'secret' }),
        expect.any(Object),
        ['/var/www/src/deleted.php'],
        expect.objectContaining({ isCancellationRequested: false })
      );
    });

    it('always shows confirmation dialog when deletions present, even if suppressed', async () => {
      (mockContext.globalState.get as jest.Mock).mockReturnValue(true);
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Proceed');
      await uploadSelected(resource, undefined, dependencies());
      expect(vscode.window.showInformationMessage).toHaveBeenCalled();
      expect(mockUpload).toHaveBeenCalled();
    });

    it('cancels when user declines deletion confirmation', async () => {
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Cancel');
      await uploadSelected(resource, undefined, dependencies());
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('shows error notification when deletions fail', async () => {
      mockUpload.mockResolvedValue({
        succeeded: [], failed: [], deleted: [],
        deleteFailed: [{ remotePath: '/var/www/src/deleted.php', error: 'Permission denied' }],
      });
      await uploadSelected(resource, undefined, dependencies());
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 file'),
        expect.any(String)
      );
    });

    it('shows success notification when all deletions succeed', async () => {
      mockUpload.mockResolvedValue({
        succeeded: [], failed: [], deleted: ['/var/www/src/deleted.php'], deleteFailed: [],
      });
      await uploadSelected(resource, undefined, dependencies());
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('deleted')
      );
    });
  });

  describe('force upload excluded files', () => {
    it('prompts user when resolveAll throws an exclusion error', async () => {
      mockResolveAll.mockImplementation(() => { throw new Error('File is excluded: /workspace/debug.log'); });
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
      await uploadSelected(resource, undefined, dependencies());
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('excluded'),
        'Upload Anyway'
      );
    });

    it('retries with ignoreExclusions when user clicks "Upload Anyway"', async () => {
      mockResolveAll
        .mockImplementationOnce(() => { throw new Error('File is excluded: /workspace/debug.log'); })
        .mockReturnValueOnce([{ localPath: '/workspace/debug.log', remotePath: '/var/www/debug.log' }])
        .mockReturnValueOnce([]);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Upload Anyway');
      await uploadSelected(resource, undefined, dependencies());
      const secondCallConfig = mockResolveAll.mock.calls[1]?.[2];
      expect(secondCallConfig).toHaveProperty('ignoreExclusions', true);
      expect(mockUpload).toHaveBeenCalled();
    });

    it('does not upload when user dismisses the exclusion prompt', async () => {
      mockResolveAll.mockReset();
      mockResolveAll.mockImplementation(() => { throw new Error('File is excluded: /workspace/debug.log'); });
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
      await uploadSelected(resource, undefined, dependencies());
      expect(mockUpload).not.toHaveBeenCalled();
    });
  });

  describe('active editor fallback', () => {
    it('uses activeTextEditor URI when called with no resource args', async () => {
      (vscode.window as any).activeTextEditor = {
        document: { uri: vscode.Uri.file('/workspace/src/app.php') },
      };
      mockResolve.mockReturnValue({ toUpload: ['/workspace/src/app.php'], toDelete: [] });
      await uploadSelected(undefined, undefined, dependencies());
      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({ resourceUri: expect.objectContaining({ fsPath: '/workspace/src/app.php' }) }),
        undefined
      );
    });

    it('shows warning when no resource args and no active editor', async () => {
      (vscode.window as any).activeTextEditor = undefined;
      mockResolve.mockReturnValue({ toUpload: [], toDelete: [] });
      await uploadSelected(undefined, undefined, dependencies());
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('No files selected')
      );
    });
  });

  describe('file date guard', () => {
    it('proceeds with upload when no remote files are newer', async () => {
      mockDateGuardCheck.mockResolvedValue([]);
      await uploadSelected(resource, undefined, dependencies());
      expect(mockUpload).toHaveBeenCalled();
    });

    it('warns user when remote files are newer and aborts on dismiss', async () => {
      mockDateGuardCheck.mockResolvedValue([
        { localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' },
      ]);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
      await uploadSelected(resource, undefined, dependencies());
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('newer on the remote'),
        'Overwrite'
      );
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('uploads when user clicks Overwrite on date guard warning', async () => {
      mockDateGuardCheck.mockResolvedValue([
        { localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' },
      ]);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Overwrite');
      await uploadSelected(resource, undefined, dependencies());
      expect(mockUpload).toHaveBeenCalled();
    });

    it('passes credential and server timeOffsetMs to date guard check', async () => {
      await uploadSelected(resource, undefined, dependencies());
      expect(mockDateGuardCheck).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ password: 'secret' }),
        undefined
      );
    });

    it('skips date guard entirely when config.fileDateGuard is false', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, fileDateGuard: false });
      await uploadSelected(resource, undefined, dependencies());
      expect(mockDateGuardCheck).not.toHaveBeenCalled();
      expect(mockUpload).toHaveBeenCalled();
    });

    it('runs date guard when config.fileDateGuard is undefined (default on)', async () => {
      const noFlag = { ...configFixture };
      delete (noFlag as any).fileDateGuard;
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(noFlag);
      await uploadSelected(resource, undefined, dependencies());
      expect(mockDateGuardCheck).toHaveBeenCalled();
    });
  });

  describe('cancellation support', () => {
    it('passes cancellable: true to withProgress', async () => {
      await uploadSelected(resource, undefined, dependencies());
      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        expect.objectContaining({ cancellable: true }),
        expect.any(Function)
      );
    });

    it('forwards CancellationToken to orchestrator.upload', async () => {
      const fakeToken = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
      (vscode.window.withProgress as any) = jest.fn().mockImplementation(
        (_opts: any, task: (p: any, token: any) => Promise<any>) => task({ report: jest.fn() }, fakeToken)
      );
      await uploadSelected(resource, undefined, dependencies());
      expect(mockUpload).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Object),
        expect.any(Object),
        expect.any(Array),
        fakeToken
      );
    });

    it('shows cancelled notification when transfer is cancelled', async () => {
      const fakeToken = { isCancellationRequested: true, onCancellationRequested: jest.fn() };
      (vscode.window.withProgress as any) = jest.fn().mockImplementation(
        (_opts: any, task: (p: any, token: any) => Promise<any>) => task({ report: jest.fn() }, fakeToken)
      );
      mockUpload.mockResolvedValue({
        succeeded: [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }],
        failed: [], deleted: [], deleteFailed: [],
        cancelled: [{ localPath: '/workspace/src/b.php', remotePath: '/var/www/src/b.php' }],
      });
      await uploadSelected(resource, undefined, dependencies());
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('cancelled')
      );
    });
  });

  describe('backup before overwrite', () => {
    it('runs cleanup and backup when backupBeforeOverwrite is true', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        backupBeforeOverwrite: true,
        backupRetentionDays: 14,
        backupMaxSizeMB: 200,
      });
      await uploadSelected(resource, undefined, dependencies());
      expect(mockCleanup).toHaveBeenCalledWith('/workspace', 14, 200);
      expect(mockBackup).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ password: 'secret' }),
        'Production',
        '/workspace'
      );
      expect(mockUpload).toHaveBeenCalled();
    });

    it('uses default retention (7) and max size (100) when not configured', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        backupBeforeOverwrite: true,
      });
      await uploadSelected(resource, undefined, dependencies());
      expect(mockCleanup).toHaveBeenCalledWith('/workspace', 7, 100);
    });

    it('skips backup when backupBeforeOverwrite is false', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        backupBeforeOverwrite: false,
      });
      await uploadSelected(resource, undefined, dependencies());
      expect(mockBackup).not.toHaveBeenCalled();
      expect(mockCleanup).not.toHaveBeenCalled();
      expect(mockUpload).toHaveBeenCalled();
    });

    it('skips backup when backupBeforeOverwrite is undefined', async () => {
      await uploadSelected(resource, undefined, dependencies());
      expect(mockBackup).not.toHaveBeenCalled();
      expect(mockCleanup).not.toHaveBeenCalled();
    });

    it('runs backup after FileDateGuard but before upload', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        backupBeforeOverwrite: true,
      });
      const callOrder: string[] = [];
      mockDateGuardCheck.mockImplementation(async () => { callOrder.push('dateGuard'); return []; });
      mockCleanup.mockImplementation(async () => { callOrder.push('cleanup'); });
      mockBackup.mockImplementation(async () => { callOrder.push('backup'); });
      mockUpload.mockImplementation(async () => { callOrder.push('upload'); return { succeeded: [], failed: [], deleted: [], deleteFailed: [] }; });

      await uploadSelected(resource, undefined, dependencies());

      expect(callOrder).toEqual(['dateGuard', 'cleanup', 'backup', 'upload']);
    });

    it('reports all three progress stages in order when backup is enabled', async () => {
      const mockReport = jest.fn();
      (vscode.window.withProgress as any) = jest.fn().mockImplementation(
        (_opts: any, task: (p: any, token: any) => Promise<any>) =>
          task({ report: mockReport }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })
      );
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        backupBeforeOverwrite: true,
      });
      await uploadSelected(resource, undefined, dependencies());
      const messages = mockReport.mock.calls.map((c: any[]) => c[0].message);
      expect(messages).toEqual([
        'Checking remote files...',
        'Backing up remote files...',
        'Uploading...',
      ]);
    });

    it('reports "Checking remote files..." then "Uploading..." when backup is disabled', async () => {
      const mockReport = jest.fn();
      (vscode.window.withProgress as any) = jest.fn().mockImplementation(
        (_opts: any, task: (p: any, token: any) => Promise<any>) =>
          task({ report: mockReport }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })
      );
      await uploadSelected(resource, undefined, dependencies());
      const messages = mockReport.mock.calls.map((c: any[]) => c[0].message);
      expect(messages).toEqual([
        'Checking remote files...',
        'Uploading...',
      ]);
    });

    it('skips "Checking remote files..." when fileDateGuard is false', async () => {
      const mockReport = jest.fn();
      (vscode.window.withProgress as any) = jest.fn().mockImplementation(
        (_opts: any, task: (p: any, token: any) => Promise<any>) =>
          task({ report: mockReport }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })
      );
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        fileDateGuard: false,
      });
      await uploadSelected(resource, undefined, dependencies());
      const messages = mockReport.mock.calls.map((c: any[]) => c[0].message);
      expect(messages).toEqual(['Uploading...']);
    });
  });

  describe('dry run mode', () => {
    beforeEach(() => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, dryRun: true });
    });

    it('calls DryRunReporter.report() when dryRun is true', async () => {
      await uploadSelected(resource, undefined, dependencies());
      expect(mockDryRunReport).toHaveBeenCalledWith([
        expect.objectContaining({ serverName: 'Production' }),
      ]);
    });

    it('does NOT call UploadOrchestratorV2.upload() when dryRun is true', async () => {
      await uploadSelected(resource, undefined, dependencies());
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('does NOT call FileDateGuard.check() when dryRun is true', async () => {
      await uploadSelected(resource, undefined, dependencies());
      expect(mockDateGuardCheck).not.toHaveBeenCalled();
    });

    it('does NOT call BackupService.backup() when dryRun is true', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, dryRun: true, backupBeforeOverwrite: true });
      await uploadSelected(resource, undefined, dependencies());
      expect(mockBackup).not.toHaveBeenCalled();
    });

    it('shows informational dry run notification', async () => {
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
      await uploadSelected(resource, undefined, dependencies());
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('dry run'),
        'Show Log'
      );
    });

    it('runs normal upload flow when dryRun is false', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, dryRun: false });
      await uploadSelected(resource, undefined, dependencies());
      expect(mockUpload).toHaveBeenCalled();
      expect(mockDryRunReport).not.toHaveBeenCalled();
    });
  });
});
