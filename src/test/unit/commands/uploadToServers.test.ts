import * as vscode from 'vscode';

// --- Module mocks (hoisted) ---
jest.mock('../../../scm/ScmResourceResolver');
jest.mock('../../../path/PathResolver');
jest.mock('../../../services/UploadOrchestratorV2');
jest.mock('../../../services/FileDateGuard');
jest.mock('../../../services/BackupService');
jest.mock('../../../services/DryRunReporter');
jest.mock('../../../services/UploadHistoryService');
jest.mock('../../../services/summaryToHistoryEntries');

import { ScmResourceResolver } from '../../../scm/ScmResourceResolver';
import { PathResolver } from '../../../path/PathResolver';
import { UploadOrchestratorV2 } from '../../../services/UploadOrchestratorV2';
import { FileDateGuard } from '../../../services/FileDateGuard';
import { BackupService } from '../../../services/BackupService';
import { DryRunReporter } from '../../../services/DryRunReporter';
import { uploadToServers } from '../../../commands/uploadToServers';
import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { summaryToHistoryEntries } from '../../../services/summaryToHistoryEntries';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';
import type { ProjectConfig, ProjectServer } from '../../../models/ProjectConfig';

const mockResolve = jest.fn();
const mockResolveAll = jest.fn();
const mockUpload = jest.fn().mockResolvedValue({ succeeded: [], failed: [], deleted: [], deleteFailed: [] });
const mockDateGuardCheck = jest.fn().mockResolvedValue([]);
const mockBackup = jest.fn().mockResolvedValue(undefined);
const mockCleanup = jest.fn().mockResolvedValue(undefined);
const mockDryRunReport = jest.fn();
const mockHistoryLog = jest.fn().mockResolvedValue(undefined);
const mockHistoryEnforceRetention = jest.fn().mockResolvedValue(undefined);
const mockSummaryToHistoryEntries = summaryToHistoryEntries as jest.Mock;
mockSummaryToHistoryEntries.mockReturnValue([{ id: 'h-1' }]);

(ScmResourceResolver as jest.Mock).mockImplementation(() => ({ resolve: mockResolve }));
(PathResolver as jest.Mock).mockImplementation(() => ({ resolveAll: mockResolveAll }));
(UploadOrchestratorV2 as jest.Mock).mockImplementation(() => ({ upload: mockUpload }));
(FileDateGuard as jest.Mock).mockImplementation(() => ({ check: mockDateGuardCheck }));
(BackupService as jest.Mock).mockImplementation(() => ({ backup: mockBackup, cleanup: mockCleanup }));
(DryRunReporter as jest.Mock).mockImplementation(() => ({ report: mockDryRunReport }));
(UploadHistoryService as jest.Mock).mockImplementation(() => ({ log: mockHistoryLog, enforceRetention: mockHistoryEnforceRetention }));

const prodServer: ProjectServer = {
  id: 'srv-1',
  type: 'sftp',
  credentialId: 'cred-1',
  credentialName: 'deploy@prod',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: '' }],
  excludedPaths: [],
};

const stagingServer: ProjectServer = {
  id: 'srv-2',
  type: 'sftp',
  credentialId: 'cred-2',
  credentialName: 'deploy@staging',
  rootPath: '/var/staging',
  mappings: [{ localPath: '/', remotePath: '/html' }],
  excludedPaths: [],
};

const configFixture: ProjectConfig = {
  defaultServerId: 'srv-1',
  uploadOnSave: false,
  servers: {
    Production: prodServer,
    Staging: stagingServer,
  },
};

const mockCredentialManager = {
  getWithSecret: jest.fn().mockImplementation((id: string) => {
    if (id === 'cred-1') {
      return Promise.resolve({
        id: 'cred-1', host: 'prod.example.com', port: 22,
        username: 'deploy', authMethod: 'password', password: 'secret1',
      });
    }
    return Promise.resolve({
      id: 'cred-2', host: 'staging.example.com', port: 22,
      username: 'deploy', authMethod: 'password', password: 'secret2',
    });
  }),
} as unknown as CredentialManager;

const mockConfigManager = {
  getConfig: jest.fn().mockResolvedValue(configFixture),
  getServerById: jest.fn(),
} as unknown as ProjectConfigManager;

const mockContext = {
  globalState: { get: jest.fn().mockReturnValue(false), update: jest.fn() },
} as unknown as vscode.ExtensionContext;

const mockOutput = {
  appendLine: jest.fn(),
  show: jest.fn(),
} as unknown as vscode.OutputChannel;

const resource = { resourceUri: vscode.Uri.file('/workspace/src/app.php') } as any;

function dependencies() {
  return { credentialManager: mockCredentialManager, configManager: mockConfigManager, context: mockContext, output: mockOutput };
}

describe('uploadToServers command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDateGuardCheck.mockResolvedValue([]);
    mockResolve.mockReturnValue({ toUpload: ['/workspace/src/app.php'], toDelete: [] });
    mockResolveAll.mockReturnValue([{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }]);
    mockUpload.mockResolvedValue({
      succeeded: [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }],
      failed: [], deleted: [], deleteFailed: [],
    });
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configFixture);
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Upload');
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue([
      { label: 'Production', serverId: 'srv-1' },
      { label: 'Staging', serverId: 'srv-2' },
    ]);
    (vscode.window.withProgress as any) = jest.fn().mockImplementation(
      (_opts: any, task: (p: any, token: any) => Promise<any>) =>
        task({ report: jest.fn() }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })
    );
  });

  it('shows warning when no files are resolved', async () => {
    mockResolve.mockReturnValue({ toUpload: [], toDelete: [] });
    await uploadToServers(resource, undefined, dependencies());
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No files selected')
    );
  });

  it('shows error when project config is missing', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(null);
    await uploadToServers(resource, undefined, dependencies());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No project configuration')
    );
  });

  it('shows error when no servers are configured', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
      ...configFixture,
      servers: {},
    });
    await uploadToServers(resource, undefined, dependencies());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No servers configured')
    );
  });

  it('shows multi-select QuickPick with all servers', async () => {
    await uploadToServers(resource, undefined, dependencies());
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Production', serverId: 'srv-1' }),
        expect.objectContaining({ label: 'Staging', serverId: 'srv-2' }),
      ]),
      expect.objectContaining({ canPickMany: true })
    );
  });

  it('aborts when user dismisses the QuickPick', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
    await uploadToServers(resource, undefined, dependencies());
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('aborts when user selects zero servers', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue([]);
    await uploadToServers(resource, undefined, dependencies());
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('resolves paths independently per server', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue([
      { label: 'Production', serverId: 'srv-1' },
      { label: 'Staging', serverId: 'srv-2' },
    ]);
    await uploadToServers(resource, undefined, dependencies());
    // resolveAll called once per server
    expect(mockResolveAll).toHaveBeenCalledTimes(2);
    // First call uses Production's config
    expect(mockResolveAll).toHaveBeenCalledWith(
      expect.any(Array),
      '/workspace',
      expect.objectContaining({ rootPath: '/var/www' })
    );
    // Second call uses Staging's config
    expect(mockResolveAll).toHaveBeenCalledWith(
      expect.any(Array),
      '/workspace',
      expect.objectContaining({ rootPath: '/var/staging' })
    );
  });

  it('uploads to all selected servers in parallel', async () => {
    await uploadToServers(resource, undefined, dependencies());
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('fetches credentials independently per server', async () => {
    await uploadToServers(resource, undefined, dependencies());
    expect(mockCredentialManager.getWithSecret).toHaveBeenCalledWith('cred-1');
    expect(mockCredentialManager.getWithSecret).toHaveBeenCalledWith('cred-2');
  });

  it('uploads to a single selected server when only one is picked', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue([
      { label: 'Production', serverId: 'srv-1' },
    ]);
    await uploadToServers(resource, undefined, dependencies());
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockCredentialManager.getWithSecret).toHaveBeenCalledWith('cred-1');
  });

  it('shows success notification with server count', async () => {
    await uploadToServers(resource, undefined, dependencies());
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('2 server(s)'),
      'Show History'
    );
  });

  it('shows per-server failure details when some servers fail', async () => {
    mockUpload
      .mockResolvedValueOnce({
        succeeded: [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }],
        failed: [], deleted: [], deleteFailed: [],
      })
      .mockRejectedValueOnce(new Error('Connection refused'));
    await uploadToServers(resource, undefined, dependencies());
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Staging'),
      'Show Log',
      'Show History'
    );
  });

  it('shows error when all servers fail', async () => {
    mockUpload.mockRejectedValue(new Error('Connection refused'));
    await uploadToServers(resource, undefined, dependencies());
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  describe('file date guard', () => {
    it('runs FileDateGuard per server', async () => {
      await uploadToServers(resource, undefined, dependencies());
      expect(mockDateGuardCheck).toHaveBeenCalledTimes(2);
    });

    it('skips FileDateGuard when config.fileDateGuard is false', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        fileDateGuard: false,
      });
      await uploadToServers(resource, undefined, dependencies());
      expect(mockDateGuardCheck).not.toHaveBeenCalled();
    });

    it('warns about newer files per server and aborts that server on dismiss', async () => {
      mockDateGuardCheck
        .mockResolvedValueOnce([{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }])
        .mockResolvedValueOnce([]);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
      await uploadToServers(resource, undefined, dependencies());
      // Only staging should upload (prod had newer files and user dismissed)
      expect(mockUpload).toHaveBeenCalledTimes(1);
    });

    it('proceeds with upload when user clicks Overwrite on date guard warning', async () => {
      mockDateGuardCheck
        .mockResolvedValueOnce([{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }])
        .mockResolvedValueOnce([]);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Overwrite');
      await uploadToServers(resource, undefined, dependencies());
      expect(mockUpload).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancellation', () => {
    it('passes cancellable: true to withProgress', async () => {
      await uploadToServers(resource, undefined, dependencies());
      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        expect.objectContaining({ cancellable: true }),
        expect.any(Function)
      );
    });

    it('forwards CancellationToken to all orchestrator uploads', async () => {
      const fakeToken = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
      (vscode.window.withProgress as any) = jest.fn().mockImplementation(
        (_opts: any, task: (p: any, token: any) => Promise<any>) => task({ report: jest.fn() }, fakeToken)
      );
      await uploadToServers(resource, undefined, dependencies());
      for (const call of mockUpload.mock.calls) {
        expect(call[4]).toBe(fakeToken);
      }
    });

    it('shows cancelled notification when transfers are cancelled', async () => {
      mockUpload.mockResolvedValue({
        succeeded: [{ localPath: '/workspace/src/app.php', remotePath: '/var/www/src/app.php' }],
        failed: [], deleted: [], deleteFailed: [],
        cancelled: [{ localPath: '/workspace/src/b.php', remotePath: '/var/www/src/b.php' }],
      });
      await uploadToServers(resource, undefined, dependencies());
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('cancelled')
      );
    });
  });

  describe('active editor fallback', () => {
    it('uses activeTextEditor URI when called with no resource args', async () => {
      (vscode.window as any).activeTextEditor = {
        document: { uri: vscode.Uri.file('/workspace/src/app.php') },
      };
      mockResolve.mockReturnValue({ toUpload: ['/workspace/src/app.php'], toDelete: [] });
      await uploadToServers(undefined, undefined, dependencies());
      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({ resourceUri: expect.objectContaining({ fsPath: '/workspace/src/app.php' }) }),
        undefined
      );
    });
  });

  describe('server with no mappings', () => {
    it('skips servers with no mappings and reports them', async () => {
      const noMappingServer: ProjectServer = {
        ...stagingServer,
        mappings: [],
      };
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        servers: { Production: prodServer, Staging: noMappingServer },
      });
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue([
        { label: 'Production', serverId: 'srv-1' },
        { label: 'Staging', serverId: 'srv-2' },
      ]);
      await uploadToServers(resource, undefined, dependencies());
      // Should only upload to Production
      expect(mockUpload).toHaveBeenCalledTimes(1);
    });
  });

  describe('backup before overwrite', () => {
    it('runs cleanup once and backup per server when backupBeforeOverwrite is true', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        backupBeforeOverwrite: true,
        backupRetentionDays: 14,
        backupMaxSizeMB: 200,
      });
      await uploadToServers(resource, undefined, dependencies());
      expect(mockCleanup).toHaveBeenCalledWith('/workspace', 14, 200);
      expect(mockBackup).toHaveBeenCalledTimes(2);
      expect(mockBackup).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ password: 'secret1' }),
        'Production',
        '/workspace'
      );
      expect(mockBackup).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ password: 'secret2' }),
        'Staging',
        '/workspace'
      );
    });

    it('uses default retention (7) and max size (100) when not configured', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        ...configFixture,
        backupBeforeOverwrite: true,
      });
      await uploadToServers(resource, undefined, dependencies());
      expect(mockCleanup).toHaveBeenCalledWith('/workspace', 7, 100);
    });

    it('skips backup when backupBeforeOverwrite is false', async () => {
      await uploadToServers(resource, undefined, dependencies());
      expect(mockBackup).not.toHaveBeenCalled();
      expect(mockCleanup).not.toHaveBeenCalled();
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
      await uploadToServers(resource, undefined, dependencies());
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
      await uploadToServers(resource, undefined, dependencies());
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
      await uploadToServers(resource, undefined, dependencies());
      const messages = mockReport.mock.calls.map((c: any[]) => c[0].message);
      expect(messages).toEqual(['Uploading...']);
    });
  });

  describe('dry run mode', () => {
    beforeEach(() => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, dryRun: true });
    });

    it('calls DryRunReporter.report() with all server plans', async () => {
      await uploadToServers(resource, undefined, dependencies());
      expect(mockDryRunReport).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ serverName: 'Production' }),
          expect.objectContaining({ serverName: 'Staging' }),
        ])
      );
    });

    it('does NOT call UploadOrchestratorV2.upload() when dryRun is true', async () => {
      await uploadToServers(resource, undefined, dependencies());
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('still builds per-server plans (path resolution runs) when dryRun is true', async () => {
      await uploadToServers(resource, undefined, dependencies());
      expect(mockResolveAll).toHaveBeenCalled();
    });

    it('shows dry run informational notification', async () => {
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
      await uploadToServers(resource, undefined, dependencies());
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('dry run'),
        'Show Log'
      );
    });

    it('runs normal upload flow when dryRun is false', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, dryRun: false });
      await uploadToServers(resource, undefined, dependencies());
      expect(mockUpload).toHaveBeenCalled();
      expect(mockDryRunReport).not.toHaveBeenCalled();
    });
  });

  describe('upload history', () => {
    it('logs history entries for each server after upload', async () => {
      await uploadToServers(resource, undefined, dependencies());
      expect(mockSummaryToHistoryEntries).toHaveBeenCalledTimes(2);
      expect(mockSummaryToHistoryEntries).toHaveBeenCalledWith(
        expect.objectContaining({ succeeded: expect.any(Array) }),
        'srv-1',
        'Production',
        expect.any(Number),
        'multi-server'
      );
      expect(mockSummaryToHistoryEntries).toHaveBeenCalledWith(
        expect.objectContaining({ succeeded: expect.any(Array) }),
        'srv-2',
        'Staging',
        expect.any(Number),
        'multi-server'
      );
      expect(mockHistoryLog).toHaveBeenCalled();
      expect(mockHistoryEnforceRetention).toHaveBeenCalled();
    });

    it('does not log history during dry run', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, dryRun: true });
      await uploadToServers(resource, undefined, dependencies());
      expect(mockHistoryLog).not.toHaveBeenCalled();
    });

    it('does not log history when historyMaxEntries is 0', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, historyMaxEntries: 0 });
      await uploadToServers(resource, undefined, dependencies());
      expect(mockHistoryLog).not.toHaveBeenCalled();
    });
  });
});
