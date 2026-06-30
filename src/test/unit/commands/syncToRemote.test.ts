import * as vscode from 'vscode';

// --- Module mocks (hoisted) ---
jest.mock('../../../path/PathResolver');
jest.mock('../../../sftpService');
jest.mock('../../../transferServiceFactory');
jest.mock('../../../services/UploadOrchestratorV2');
jest.mock('../../../services/BackupService');
jest.mock('../../../services/DryRunReporter');
jest.mock('../../../services/UploadHistoryService');
jest.mock('../../../services/summaryToHistoryEntries');
jest.mock('../../../services/SyncReconciler');
jest.mock('../../../services/SyncTreeWalker');
jest.mock('../../../uploadConfirmation');
jest.mock('fs');

import * as fs from 'fs';
import { PathResolver } from '../../../path/PathResolver';
import { SftpService } from '../../../sftpService';
import { createTransferService } from '../../../transferServiceFactory';
import { UploadOrchestratorV2 } from '../../../services/UploadOrchestratorV2';
import { BackupService } from '../../../services/BackupService';
import { DryRunReporter } from '../../../services/DryRunReporter';
import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { summaryToHistoryEntries } from '../../../services/summaryToHistoryEntries';
import { reconcile } from '../../../services/SyncReconciler';
import { walkLocalTree, walkRemoteTree } from '../../../services/SyncTreeWalker';
import { UploadConfirmation } from '../../../uploadConfirmation';
import { syncToRemote } from '../../../commands/syncToRemote';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';
import type { ProjectConfig, ProjectServer } from '../../../models/ProjectConfig';

const mockResolve = jest.fn().mockReturnValue({ localPath: '/workspace', remotePath: '/var/www' });
const mockResolveLocalPath = jest.fn().mockReturnValue('/workspace/x');
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn().mockResolvedValue(undefined);
const mockUpload = jest.fn().mockResolvedValue({ succeeded: [], failed: [], deleted: [], deleteFailed: [] });
const mockBackup = jest.fn().mockResolvedValue(undefined);
const mockCleanup = jest.fn().mockResolvedValue(undefined);
const mockDryRunReport = jest.fn();
const mockHistoryLog = jest.fn().mockResolvedValue(undefined);
const mockEnforceRetention = jest.fn().mockResolvedValue(undefined);
const mockConfirm = jest.fn().mockResolvedValue(true);
const mockConfirmSyncDeletions = jest.fn().mockResolvedValue(true);

(PathResolver as jest.Mock).mockImplementation(() => ({
  resolve: mockResolve,
  resolveLocalPath: mockResolveLocalPath,
}));
(SftpService as jest.Mock).mockImplementation(() => ({ connect: mockConnect, disconnect: mockDisconnect }));
(createTransferService as jest.Mock).mockReturnValue({ connect: mockConnect, disconnect: mockDisconnect });
(UploadOrchestratorV2 as jest.Mock).mockImplementation(() => ({ upload: mockUpload }));
(BackupService as jest.Mock).mockImplementation(() => ({ backup: mockBackup, cleanup: mockCleanup }));
(DryRunReporter as jest.Mock).mockImplementation(() => ({ report: mockDryRunReport }));
(UploadHistoryService as jest.Mock).mockImplementation(() => ({
  log: mockHistoryLog,
  enforceRetention: mockEnforceRetention,
}));
(UploadConfirmation as jest.Mock).mockImplementation(() => ({
  confirm: mockConfirm,
  confirmSyncDeletions: mockConfirmSyncDeletions,
}));

const mockReconcile = reconcile as jest.Mock;
const mockWalkLocalTree = walkLocalTree as jest.Mock;
const mockWalkRemoteTree = walkRemoteTree as jest.Mock;
const mockSummaryToHistoryEntries = summaryToHistoryEntries as jest.Mock;
const mockCreateTransferService = createTransferService as jest.Mock;

const server: ProjectServer = {
  id: 'srv-1',
  type: 'sftp',
  credentialId: 'cred-1',
  credentialName: 'deploy@prod',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: '' }],
  excludedPaths: [],
  timeOffsetMs: 0,
};

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { defaultServerId: 'srv-1', servers: { Production: server }, ...overrides };
}

const uploadItem = { localPath: '/workspace/a.php', remotePath: '/var/www/a.php' };

const mockConfigManager = {
  getServerHooks: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn(),
  getServerById: jest.fn().mockResolvedValue({ name: 'Production', server }),
} as unknown as ProjectConfigManager;

const mockCredentialManager = {
  getWithSecret: jest.fn().mockResolvedValue({ id: 'cred-1', password: 'secret' }),
} as unknown as CredentialManager;

const dependencies = {
  credentialManager: mockCredentialManager,
  configManager: mockConfigManager,
  context: { globalState: { get: jest.fn(), update: jest.fn() } },
  output: { appendLine: jest.fn(), show: jest.fn() },
} as any;

function planWith(overrides: {
  toUpload?: typeof uploadItem[];
  upToDate?: typeof uploadItem[];
  remoteExtras?: string[];
}) {
  return {
    toUpload: overrides.toUpload ?? [],
    upToDate: overrides.upToDate ?? [],
    remoteExtras: overrides.remoteExtras ?? [],
  };
}

describe('syncToRemote', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockReturnValue({ localPath: '/workspace', remotePath: '/var/www' });
    mockResolveLocalPath.mockReturnValue('/workspace/x');
    mockUpload.mockResolvedValue({ succeeded: [uploadItem], failed: [], deleted: [], deleteFailed: [] });
    mockWalkLocalTree.mockReturnValue([]);
    mockWalkRemoteTree.mockResolvedValue([]);
    mockCleanup.mockResolvedValue(undefined);
    (fs.statSync as jest.Mock).mockReturnValue({ mtimeMs: 1000 });
    mockCreateTransferService.mockReturnValue({ connect: mockConnect, disconnect: mockDisconnect });
    mockConfirm.mockResolvedValue(true);
    mockConfirmSyncDeletions.mockResolvedValue(true);
    mockSummaryToHistoryEntries.mockReturnValue([{ id: 'h-1' }]);
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(makeConfig());
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.withProgress as any) = jest.fn().mockImplementation(
      (_opts: any, task: (p: any, token: any) => Promise<any>) =>
        task({ report: jest.fn() }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })
    );
  });

  it('passes an empty delete list when delete-extras is OFF', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: false });

    await syncToRemote(dependencies);

    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0][3]).toEqual([]); // deleteRemotePaths
  });

  it('passes the remote extras as the delete list when delete-extras is ON', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });

    await syncToRemote(dependencies);

    expect(mockUpload.mock.calls[0][3]).toEqual(['/var/www/stale.php']);
  });

  it('backs up each extra before deletion when syncBackupBeforeDelete is ON (default)', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });

    await syncToRemote(dependencies);

    expect(mockBackup).toHaveBeenCalledTimes(1);
    expect(mockBackup.mock.calls[0][0]).toEqual([{ localPath: '', remotePath: '/var/www/stale.php' }]);
    // Backed up strictly before the orchestrator deletes.
    expect(mockBackup.mock.invocationCallOrder[0]).toBeLessThan(mockUpload.mock.invocationCallOrder[0]);
  });

  it('does NOT back up before delete when syncBackupBeforeDelete is OFF', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(makeConfig({ syncBackupBeforeDelete: false }));
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });

    await syncToRemote(dependencies);

    expect(mockBackup).not.toHaveBeenCalled();
    expect(mockUpload.mock.calls[0][3]).toEqual(['/var/www/stale.php']);
  });

  it('never calls the orchestrator when the delete confirmation is declined', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });
    mockConfirmSyncDeletions.mockResolvedValue(false);

    await syncToRemote(dependencies);

    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockBackup).not.toHaveBeenCalled();
  });

  it('returns without uploading when the QuickPick is cancelled', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

    await syncToRemote(dependencies);

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('dry-run reports uploads AND deletes and does not transfer', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(makeConfig({ dryRun: true }));
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });

    await syncToRemote(dependencies);

    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockDryRunReport).toHaveBeenCalledTimes(1);
    const reportedPlan = mockDryRunReport.mock.calls[0][0][0];
    expect(reportedPlan.uploadItems).toEqual([uploadItem]);
    expect(reportedPlan.deleteRemotePaths).toEqual(['/var/www/stale.php']);
  });

  it('throws rather than delete a path outside the mapped remote root (safety #5)', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/etc/passwd'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });

    await expect(syncToRemote(dependencies)).rejects.toThrow(/outside the mapped remote root/);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('logs history with the sync trigger', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] })); // no extras → no QuickPick

    await syncToRemote(dependencies);

    expect(mockUpload).toHaveBeenCalledTimes(1);
    const triggerArgument = mockSummaryToHistoryEntries.mock.calls[0][4];
    expect(triggerArgument).toBe('sync');
    expect(mockHistoryLog).toHaveBeenCalled();
  });

  it('reports a cancelled sync (deletes skipped by the orchestrator)', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });
    mockUpload.mockResolvedValue({
      succeeded: [], failed: [], deleted: [], deleteFailed: [], cancelled: [uploadItem],
    });

    await syncToRemote(dependencies);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('cancelled')
    );
  });

  it('reports up-to-date and skips everything when there is nothing to do', async () => {
    mockReconcile.mockReturnValue(planWith({ upToDate: [uploadItem] }));

    await syncToRemote(dependencies);

    expect(mockUpload).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('up to date')
    );
  });

  it('connects for the remote walk via the transfer factory using the server type (FTP support)', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] }));

    await syncToRemote(dependencies);

    // The walk must honour the configured protocol, not hard-code SFTP.
    expect(mockCreateTransferService).toHaveBeenCalledWith('sftp');
    expect(SftpService).not.toHaveBeenCalled();
  });

  it('excludes .git and node_modules from the local and remote walks', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] }));

    await syncToRemote(dependencies);

    const localIgnored = mockWalkLocalTree.mock.calls[0][1] as Set<string>;
    expect(localIgnored).toBeInstanceOf(Set);
    expect(localIgnored.has('.git')).toBe(true);
    expect(localIgnored.has('node_modules')).toBe(true);

    const remoteIgnored = mockWalkRemoteTree.mock.calls[0][3] as Set<string>;
    expect(remoteIgnored).toBeInstanceOf(Set);
    expect(remoteIgnored.has('.git')).toBe(true);
    expect(remoteIgnored.has('node_modules')).toBe(true);
  });

  it('skips a local file that disappears between walk and stat (per-file, no abort)', async () => {
    mockWalkLocalTree.mockReturnValue(['/workspace/gone.php', '/workspace/ok.php']);
    (fs.statSync as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath === '/workspace/gone.php') {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return { mtimeMs: 1234 };
    });
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] }));

    await syncToRemote(dependencies);

    // The run completes; reconcile only sees the file that still exists.
    const localFilesArgument = mockReconcile.mock.calls[0][0];
    expect(localFilesArgument).toHaveLength(1);
    expect(localFilesArgument[0].localPath).toBe('/workspace/ok.php');
  });

  it('backs up remote files before overwrite when backupBeforeOverwrite is ON', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(makeConfig({ backupBeforeOverwrite: true }));
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] })); // no extras → no QuickPick

    await syncToRemote(dependencies);

    expect(mockCleanup).toHaveBeenCalled();
    expect(mockBackup).toHaveBeenCalledTimes(1);
    expect(mockBackup.mock.calls[0][0]).toEqual([uploadItem]);
    // Backed up strictly before the orchestrator uploads.
    expect(mockBackup.mock.invocationCallOrder[0]).toBeLessThan(mockUpload.mock.invocationCallOrder[0]);
  });

  it('does NOT back up overwrites when backupBeforeOverwrite is OFF (default)', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] }));

    await syncToRemote(dependencies);

    expect(mockBackup).not.toHaveBeenCalled();
    expect(mockCleanup).not.toHaveBeenCalled();
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('backs up overwrites and deletes (overwrite first), cleaning up once', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(makeConfig({ backupBeforeOverwrite: true }));
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/var/www/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });

    await syncToRemote(dependencies);

    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(mockBackup).toHaveBeenCalledTimes(2);
    expect(mockBackup.mock.calls[0][0]).toEqual([uploadItem]); // overwrite backup first
    expect(mockBackup.mock.calls[1][0]).toEqual([{ localPath: '', remotePath: '/var/www/stale.php' }]);
  });

  it('errors when there is no project configuration', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(undefined);

    await syncToRemote(dependencies);

    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
