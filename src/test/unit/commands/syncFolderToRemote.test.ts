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

import { PathResolver } from '../../../path/PathResolver';
import { createTransferService } from '../../../transferServiceFactory';
import { UploadOrchestratorV2 } from '../../../services/UploadOrchestratorV2';
import { BackupService } from '../../../services/BackupService';
import { DryRunReporter } from '../../../services/DryRunReporter';
import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { summaryToHistoryEntries } from '../../../services/summaryToHistoryEntries';
import { reconcile } from '../../../services/SyncReconciler';
import { walkLocalTree, walkRemoteTree } from '../../../services/SyncTreeWalker';
import { UploadConfirmation } from '../../../uploadConfirmation';
import { syncFolderToRemote } from '../../../commands/syncToRemote';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';
import type { ProjectConfig, ProjectServer } from '../../../models/ProjectConfig';

// Resolve maps /workspace/... -> /www/... so a folder's remote subtree root is deterministic.
const mockResolve = jest.fn((p: string) => ({ localPath: p, remotePath: p.replace('/workspace', '/www') }));
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
(createTransferService as jest.Mock).mockReturnValue({ connect: mockConnect, disconnect: mockDisconnect });
(UploadOrchestratorV2 as jest.Mock).mockImplementation(() => ({ upload: mockUpload }));
(BackupService as unknown as jest.Mock).mockImplementation(() => ({ backup: mockBackup, cleanup: mockCleanup }));
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

const server: ProjectServer = {
  id: 'srv-1', type: 'sftp', credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/www', mappings: [{ localPath: '/', remotePath: '' }], excludedPaths: [], timeOffsetMs: 0,
};

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { defaultServerId: 'srv-1', servers: { SyncTest: server }, ...overrides };
}

const uploadItem = { localPath: '/workspace/public/assets/site.css', remotePath: '/www/public/assets/site.css' };

const mockConfigManager = {
  getServerHooks: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn(),
  getServerById: jest.fn().mockResolvedValue({ name: 'SyncTest', server }),
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

const FOLDER = '/workspace/public/assets';

function planWith(overrides: { toUpload?: any[]; upToDate?: any[]; remoteExtras?: string[] }) {
  return {
    toUpload: overrides.toUpload ?? [],
    upToDate: overrides.upToDate ?? [],
    remoteExtras: overrides.remoteExtras ?? [],
  };
}

describe('syncFolderToRemote', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockImplementation((p: string) => ({ localPath: p, remotePath: p.replace('/workspace', '/www') }));
    mockResolveLocalPath.mockReturnValue('/workspace/x');
    mockUpload.mockResolvedValue({ succeeded: [uploadItem], failed: [], deleted: [], deleteFailed: [] });
    mockWalkLocalTree.mockReturnValue([]);
    mockWalkRemoteTree.mockResolvedValue([]);
    mockCleanup.mockResolvedValue(undefined);
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

  it('walks only the selected folder, locally and remotely', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] }));

    await syncFolderToRemote([FOLDER], dependencies);

    expect(mockWalkLocalTree).toHaveBeenCalledWith(FOLDER, expect.any(Set));
    // Remote walk is bounded to the folder's resolved remote subtree root.
    expect(mockWalkRemoteTree).toHaveBeenCalledWith(
      expect.anything(), '/www/public/assets', expect.anything(), expect.any(Set)
    );
  });

  it('SAFETY: refuses to delete an extra outside the selected folder subtree', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/www/other/stale.php'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });

    await expect(syncFolderToRemote([FOLDER], dependencies)).rejects.toThrow(/outside the mapped remote root/);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('prunes an extra that IS inside the selected folder subtree', async () => {
    mockReconcile.mockReturnValue(planWith({
      toUpload: [uploadItem], remoteExtras: ['/www/public/assets/old.js'],
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: true });

    await syncFolderToRemote([FOLDER], dependencies);

    expect(mockUpload.mock.calls[0][3]).toEqual(['/www/public/assets/old.js']);
  });

  it('passes an empty delete list when delete-extras is OFF', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem], remoteExtras: ['/www/public/assets/old.js'] }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ deleteExtras: false });

    await syncFolderToRemote([FOLDER], dependencies);

    expect(mockUpload.mock.calls[0][3]).toEqual([]);
  });

  it('errors when the folder is under no mapping, without calling the orchestrator', async () => {
    mockResolve.mockImplementation(() => { throw new Error('No mapping found'); });
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] }));

    await syncFolderToRemote(['/workspace/outside'], dependencies);

    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(mockWalkRemoteTree).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('syncs the union of multiple selected folders', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] }));

    await syncFolderToRemote(['/workspace/public/assets', '/workspace/src'], dependencies);

    expect(mockWalkLocalTree).toHaveBeenCalledWith('/workspace/public/assets', expect.any(Set));
    expect(mockWalkLocalTree).toHaveBeenCalledWith('/workspace/src', expect.any(Set));
    expect(mockWalkRemoteTree).toHaveBeenCalledWith(expect.anything(), '/www/public/assets', expect.anything(), expect.any(Set));
    expect(mockWalkRemoteTree).toHaveBeenCalledWith(expect.anything(), '/www/src', expect.anything(), expect.any(Set));
  });

  it('logs history with the sync trigger', async () => {
    mockReconcile.mockReturnValue(planWith({ toUpload: [uploadItem] }));

    await syncFolderToRemote([FOLDER], dependencies);

    expect(mockSummaryToHistoryEntries.mock.calls[0][4]).toBe('sync');
    expect(mockHistoryLog).toHaveBeenCalled();
  });

  it('warns and does nothing when no folder is provided', async () => {
    await syncFolderToRemote([], dependencies);

    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
