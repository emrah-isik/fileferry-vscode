import * as child_process from 'child_process';

jest.mock('../../../path/PathResolver');
jest.mock('../../../services/UploadOrchestratorV2');
jest.mock('../../../transferServiceFactory');
jest.mock('../../../services/FileDateGuard');
jest.mock('../../../services/UploadHistoryService');
jest.mock('../../../services/summaryToHistoryEntries');
jest.mock('child_process');

import { PathResolver } from '../../../path/PathResolver';
import { UploadOrchestratorV2 } from '../../../services/UploadOrchestratorV2';
import { createTransferService } from '../../../transferServiceFactory';
import { FileDateGuard } from '../../../services/FileDateGuard';
import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { summaryToHistoryEntries } from '../../../services/summaryToHistoryEntries';
import { autoUploadFile } from '../../../services/autoUpload';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';
import type { ProjectConfig } from '../../../models/ProjectConfig';

const mockResolve = jest.fn();
const mockUpload = jest.fn();
const mockDateGuardCheck = jest.fn();
const mockHistoryLog = jest.fn().mockResolvedValue(undefined);
const mockHistoryEnforceRetention = jest.fn().mockResolvedValue(undefined);
const mockSummaryToHistoryEntries = summaryToHistoryEntries as jest.Mock;

(PathResolver as jest.Mock).mockImplementation(() => ({ resolve: mockResolve }));
(UploadOrchestratorV2 as jest.Mock).mockImplementation(() => ({ upload: mockUpload }));

const sentinelTransfer = { connect: jest.fn(), disconnect: jest.fn() };
(createTransferService as jest.Mock).mockReturnValue(sentinelTransfer);
(FileDateGuard as jest.Mock).mockImplementation(() => ({ check: mockDateGuardCheck }));
(UploadHistoryService as jest.Mock).mockImplementation(() => ({ log: mockHistoryLog, enforceRetention: mockHistoryEnforceRetention }));

const mockExecFile = child_process.execFile as unknown as jest.Mock;

const server = {
  id: 'srv-1', type: 'sftp', credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/var/www', mappings: [{ localPath: '/', remotePath: '' }], excludedPaths: [],
};

const config: ProjectConfig = { defaultServerId: 'srv-1', servers: { Production: server as any } } as any;

const mockConfigManager = {
  getServerById: jest.fn(),
} as unknown as ProjectConfigManager;

const mockCredentialManager = {
  getWithSecret: jest.fn().mockResolvedValue({ id: 'cred-1', authMethod: 'password', password: 'secret' }),
} as unknown as CredentialManager;

function deps() {
  return { credentialManager: mockCredentialManager, configManager: mockConfigManager };
}

describe('autoUploadFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue({ name: 'Production', server });
    mockResolve.mockReturnValue({ localPath: '/workspace/dist/app.js', remotePath: '/var/www/dist/app.js' });
    mockUpload.mockResolvedValue({ succeeded: [{ localPath: '/workspace/dist/app.js' }], failed: [], deleted: [], deleteFailed: [] });
    mockDateGuardCheck.mockResolvedValue([]);
    mockSummaryToHistoryEntries.mockReturnValue([{ id: 'h-1' }]);
    // Default git mock: file IS ignored (exit 0) — proves the allowlist bypasses it
    mockExecFile.mockImplementation((_c: string, _a: string[], _o: any, cb: (error: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
  });

  describe('the allowlist decision (applyGitIgnore)', () => {
    it('uploads a git-ignored file when applyGitIgnore is false (watcher behaviour)', async () => {
      const outcome = await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'watch', { applyGitIgnore: false });

      expect(mockExecFile).not.toHaveBeenCalled(); // never even asks git
      expect(mockUpload).toHaveBeenCalled();
      expect(outcome.status).toBe('uploaded');
    });

    it('skips a git-ignored file when applyGitIgnore is true (on-save behaviour)', async () => {
      const outcome = await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'save', { applyGitIgnore: true });

      expect(mockUpload).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ status: 'skipped', reason: 'gitignored' });
    });
  });

  it('constructs the orchestrator with the transport matching the server type', async () => {
    await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'watch', { applyGitIgnore: false });
    expect(createTransferService).toHaveBeenCalledWith('sftp');
    expect(UploadOrchestratorV2).toHaveBeenCalledWith(sentinelTransfer);
  });

  it('logs history with the given trigger', async () => {
    await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'watch', { applyGitIgnore: false });

    expect(mockSummaryToHistoryEntries).toHaveBeenCalledWith(
      expect.any(Object), 'srv-1', 'Production', expect.any(Number), 'watch'
    );
    expect(mockHistoryLog).toHaveBeenCalledWith([{ id: 'h-1' }]);
  });

  it('returns no-server when the default server is missing', async () => {
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue(undefined);
    const outcome = await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'watch', { applyGitIgnore: false });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'no-server' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('returns excluded when PathResolver throws', async () => {
    mockResolve.mockImplementation(() => { throw new Error('File is excluded: dist/app.js'); });
    const outcome = await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'watch', { applyGitIgnore: false });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'excluded' });
  });

  it('returns remote-newer when the date guard reports a newer remote', async () => {
    mockDateGuardCheck.mockResolvedValue([{ localPath: '/workspace/dist/app.js' }]);
    const outcome = await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'watch', { applyGitIgnore: false });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'remote-newer' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('skips the date guard when fileDateGuard is false', async () => {
    const outcome = await autoUploadFile('/workspace/dist/app.js', '/workspace', { ...config, fileDateGuard: false }, deps(), 'watch', { applyGitIgnore: false });
    expect(mockDateGuardCheck).not.toHaveBeenCalled();
    expect(outcome.status).toBe('uploaded');
  });

  it('still uploads when the date guard throws (non-blocking)', async () => {
    mockDateGuardCheck.mockRejectedValue(new Error('timeout'));
    const outcome = await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'watch', { applyGitIgnore: false });
    expect(outcome.status).toBe('uploaded');
  });

  it('returns error when the orchestrator throws', async () => {
    mockUpload.mockRejectedValue(new Error('Connection refused'));
    const outcome = await autoUploadFile('/workspace/dist/app.js', '/workspace', config, deps(), 'watch', { applyGitIgnore: false });
    expect(outcome).toMatchObject({ status: 'error', error: 'Connection refused' });
    expect(mockHistoryLog).not.toHaveBeenCalled();
  });

  it('does not log history when historyMaxEntries is 0', async () => {
    await autoUploadFile('/workspace/dist/app.js', '/workspace', { ...config, historyMaxEntries: 0 }, deps(), 'watch', { applyGitIgnore: false });
    expect(mockHistoryLog).not.toHaveBeenCalled();
  });
});
