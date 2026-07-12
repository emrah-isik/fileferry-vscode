import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';

jest.mock('fs/promises');
jest.mock('../../../services/UploadHistoryService');
jest.mock('../../../services/BackupService', () => ({
  BackupService: { writeBackup: jest.fn() },
}));

import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { BackupService } from '../../../services/BackupService';
import { RemoteEditSaveListener } from '../../../services/RemoteEditSaveListener';
import { RemoteEditSessionRegistry, RemoteEditSession } from '../../../services/RemoteEditSessionRegistry';

const TEMP_PATH = path.join('/tmp', 'fileferry-browse', 'index.remote.abc123.php');
const REMOTE_PATH = '/var/www/index.php';
const DOWNLOADED_CONTENT = Buffer.from('<?php echo "original";');
const DOWNLOADED_SHA256 = crypto.createHash('sha256').update(DOWNLOADED_CONTENT).digest('hex');
const BASE_MTIME_MS = new Date('2026-07-12T10:00:00Z').getTime();
const EDITED_CONTENT = Buffer.from('<?php echo "edited";');

const mockConnection = {
  statRemote: jest.fn(),
  downloadFile: jest.fn(),
  uploadFile: jest.fn(),
};

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
};

const mockOutput = { appendLine: jest.fn(), show: jest.fn() };

const mockHistoryLog = jest.fn();
const mockHistoryEnforceRetention = jest.fn();
(UploadHistoryService as unknown as jest.Mock).mockImplementation(() => ({
  log: mockHistoryLog,
  enforceRetention: mockHistoryEnforceRetention,
}));
const mockWriteBackup = BackupService.writeBackup as jest.Mock;

const server = {
  id: 'server-1', type: 'sftp' as const,
  credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/var/www', mappings: [], excludedPaths: [],
};
const otherServer = { ...server, id: 'server-2' };
const baseConfig = { defaultServerId: 'server-1', servers: { Production: server } };

let saveCallback: (doc: unknown) => Promise<void>;
let closeCallback: (doc: unknown) => void;

function makeDoc(fsPath: string = TEMP_PATH) {
  return { uri: { fsPath } };
}

function session(overrides: Partial<RemoteEditSession> = {}): RemoteEditSession {
  return {
    serverId: 'server-1',
    remotePath: REMOTE_PATH,
    downloadedMtimeMs: BASE_MTIME_MS,
    sha256: DOWNLOADED_SHA256,
    ...overrides,
  };
}

describe('RemoteEditSaveListener', () => {
  let registry: RemoteEditSessionRegistry;
  let listener: RemoteEditSaveListener;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new RemoteEditSessionRegistry();

    (vscode.workspace.onDidSaveTextDocument as jest.Mock).mockImplementation((callback: any) => {
      saveCallback = callback;
      return { dispose: jest.fn() };
    });
    (vscode.workspace.onDidCloseTextDocument as jest.Mock).mockImplementation((callback: any) => {
      closeCallback = callback;
      return { dispose: jest.fn() };
    });
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.window.withProgress as jest.Mock).mockImplementation(
      (_opts: any, task: (progress: any) => Promise<any>) => task({ report: jest.fn() })
    );
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockImplementation(async (id: string) =>
      id === 'server-1' ? { name: 'Production', server } : undefined
    );
    mockConnection.statRemote.mockResolvedValue({ mtime: new Date(BASE_MTIME_MS) });
    mockConnection.downloadFile.mockResolvedValue(DOWNLOADED_CONTENT);
    mockConnection.uploadFile.mockResolvedValue(undefined);
    mockWriteBackup.mockResolvedValue(undefined);
    mockHistoryLog.mockResolvedValue(undefined);
    mockHistoryEnforceRetention.mockResolvedValue(undefined);
    (fs.readFile as jest.Mock).mockResolvedValue(EDITED_CONTENT);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

    listener = new RemoteEditSaveListener({
      registry,
      connection: mockConnection as any,
      configManager: mockConfigManager as any,
      output: mockOutput as any,
    });
    listener.register();
  });

  describe('untracked saves', () => {
    it('ignores saves on paths that are not registered', async () => {
      await saveCallback(makeDoc(path.join('/workspace', 'src', 'app.php')));

      expect(mockConfigManager.getConfig).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
  });

  describe('happy path (remote unchanged)', () => {
    it('uploads back to the originating server without prompting', async () => {
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.uploadFile).toHaveBeenCalledWith(TEMP_PATH, REMOTE_PATH);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('does not download the remote content when the mtime is unchanged', async () => {
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
    });

    it('logs a success history entry with the remote-edit trigger and enforces retention', async () => {
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockHistoryLog).toHaveBeenCalledWith([
        expect.objectContaining({
          serverId: 'server-1',
          serverName: 'Production',
          localPath: TEMP_PATH,
          remotePath: REMOTE_PATH,
          action: 'upload',
          result: 'success',
          trigger: 'remote-edit',
        }),
      ]);
      expect(mockHistoryEnforceRetention).toHaveBeenCalled();
    });

    it('refreshes BOTH the mtime baseline and the sha256 after a successful upload', async () => {
      // Stale sha256 after upload would flag the next merely-touched save as
      // a conflict: the remote now holds this save's bytes, not the original.
      const postUploadMtime = new Date('2026-07-12T10:05:00Z');
      mockConnection.statRemote
        .mockResolvedValueOnce({ mtime: new Date(BASE_MTIME_MS) }) // conflict check
        .mockResolvedValueOnce({ mtime: postUploadMtime });        // baseline refresh
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(registry.get(TEMP_PATH)).toEqual(session({
        downloadedMtimeMs: postUploadMtime.getTime(),
        sha256: crypto.createHash('sha256').update(EDITED_CONTENT).digest('hex'),
      }));
    });

    it('shows a status bar confirmation', async () => {
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('index.php'),
        expect.any(Number)
      );
    });

    it('shows a visible error and logs a failed history entry when the upload throws', async () => {
      mockConnection.uploadFile.mockRejectedValue(new Error('EACCES: permission denied'));
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(TEMP_PATH)
      );
      expect(mockHistoryLog).toHaveBeenCalledWith([
        expect.objectContaining({ result: 'failed', error: expect.stringContaining('EACCES'), trigger: 'remote-edit' }),
      ]);
    });
  });

  describe('dry run (D2)', () => {
    it('logs "would upload" and transfers nothing', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringMatching(/would upload.*\/var\/www\/index\.php/i)
      );
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockConnection.statRemote).not.toHaveBeenCalled();
      expect(mockConnection.downloadFile).not.toHaveBeenCalled();
    });
  });

  describe('server binding', () => {
    it('warns and does not upload when the default server changed since open', async () => {
      mockConfigManager.getConfig.mockResolvedValue({
        defaultServerId: 'server-2',
        servers: { Production: server, Staging: otherServer },
      });
      mockConfigManager.getServerById.mockImplementation(async (id: string) => {
        if (id === 'server-1') { return { name: 'Production', server }; }
        if (id === 'server-2') { return { name: 'Staging', server: otherServer }; }
        return undefined;
      });
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      const warning = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0] as string;
      expect(warning).toContain('Production');
      expect(warning).toContain('Staging');
      expect(warning).toContain(TEMP_PATH);
    });

    it('shows a visible error when the originating server no longer exists', async () => {
      mockConfigManager.getServerById.mockResolvedValue(undefined);
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(TEMP_PATH)
      );
    });

    it('shows a visible error when no project config exists', async () => {
      mockConfigManager.getConfig.mockResolvedValue(null);
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });
  });

  describe('conflict detection (D4 — fail closed)', () => {
    it('uploads without prompting when the mtime changed but the content did not (merely touched)', async () => {
      mockConnection.statRemote.mockResolvedValue({ mtime: new Date(BASE_MTIME_MS + 60_000) });
      mockConnection.downloadFile.mockResolvedValue(DOWNLOADED_CONTENT); // same bytes
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).toHaveBeenCalled();
    });

    it('prompts when the remote content actually changed, and cancels by default', async () => {
      mockConnection.statRemote.mockResolvedValue({ mtime: new Date(BASE_MTIME_MS + 60_000) });
      mockConnection.downloadFile.mockResolvedValue(Buffer.from('someone else edited this'));
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(mockHistoryLog).toHaveBeenCalledWith([
        expect.objectContaining({ result: 'cancelled', trigger: 'remote-edit' }),
      ]);
    });

    it('uploads when the user chooses Overwrite on a real conflict', async () => {
      mockConnection.statRemote.mockResolvedValueOnce({ mtime: new Date(BASE_MTIME_MS + 60_000) });
      mockConnection.downloadFile.mockResolvedValue(Buffer.from('someone else edited this'));
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Overwrite');
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.uploadFile).toHaveBeenCalledWith(TEMP_PATH, REMOTE_PATH);
    });

    it('writes the remote version to a temp file and opens a diff when the user chooses Show Diff', async () => {
      const remoteVersion = Buffer.from('someone else edited this');
      mockConnection.statRemote.mockResolvedValue({ mtime: new Date(BASE_MTIME_MS + 60_000) });
      mockConnection.downloadFile.mockResolvedValue(remoteVersion);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Show Diff');
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      const extension = path.extname(TEMP_PATH);
      const conflictTempPath = path.join(
        path.dirname(TEMP_PATH),
        `${path.basename(TEMP_PATH, extension)}.conflict${extension}`
      );
      expect(fs.writeFile).toHaveBeenCalledWith(conflictTempPath, remoteVersion);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.anything(),
        expect.anything(),
        expect.any(String)
      );
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    });

    it('treats an mtime that moved BACKWARDS as a conflict too', async () => {
      // A restored backup is still someone else's change — `>` would miss it.
      mockConnection.statRemote.mockResolvedValue({ mtime: new Date(BASE_MTIME_MS - 60_000) });
      mockConnection.downloadFile.mockResolvedValue(Buffer.from('restored older version'));
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    });

    it('prompts when the remote file was deleted since open, and can recreate it', async () => {
      mockConnection.statRemote.mockResolvedValue(null);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Upload Anyway');
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, backupBeforeOverwrite: true });
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(mockConnection.uploadFile).toHaveBeenCalled();
      expect(mockWriteBackup).not.toHaveBeenCalled(); // nothing left to back up
    });

    it('does not upload when the user cancels the deleted-remotely prompt', async () => {
      mockConnection.statRemote.mockResolvedValue(null);
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    });

    it('fails closed when stat throws: prompts instead of assuming no conflict', async () => {
      mockConnection.statRemote.mockRejectedValue(new Error('connection reset'));
      mockConnection.downloadFile.mockRejectedValue(new Error('connection reset'));
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
    });

    it('fails closed on a NaN baseline but lets the sha256 check rescue an unchanged remote', async () => {
      // Open-time stat failed (baseline NaN) — mtime comparison is impossible,
      // but the remote content still matches what we downloaded, so no prompt.
      registry.register(TEMP_PATH, session({ downloadedMtimeMs: Number.NaN }));

      await saveCallback(makeDoc());

      expect(mockConnection.downloadFile).toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.uploadFile).toHaveBeenCalled();
    });
  });

  describe('backup before overwrite (D3)', () => {
    it('backs up the current remote bytes before uploading', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, backupBeforeOverwrite: true });
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockWriteBackup).toHaveBeenCalledWith(REMOTE_PATH, DOWNLOADED_CONTENT, 'Production', '/workspace');
      const backupOrder = mockWriteBackup.mock.invocationCallOrder[0];
      const uploadOrder = mockConnection.uploadFile.mock.invocationCallOrder[0];
      expect(backupOrder).toBeLessThan(uploadOrder);
    });

    it('reuses the bytes already downloaded by the conflict check (no second download)', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, backupBeforeOverwrite: true });
      mockConnection.statRemote.mockResolvedValueOnce({ mtime: new Date(BASE_MTIME_MS + 60_000) });
      mockConnection.downloadFile.mockResolvedValue(DOWNLOADED_CONTENT); // touched, not changed
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.downloadFile).toHaveBeenCalledTimes(1);
      expect(mockWriteBackup).toHaveBeenCalledWith(REMOTE_PATH, DOWNLOADED_CONTENT, 'Production', '/workspace');
      expect(mockConnection.uploadFile).toHaveBeenCalled();
    });

    it('aborts the upload with a visible error when the backup fails', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, backupBeforeOverwrite: true });
      mockWriteBackup.mockRejectedValue(new Error('disk full'));
      registry.register(TEMP_PATH, session());

      await saveCallback(makeDoc());

      expect(mockConnection.uploadFile).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('disk full')
      );
    });
  });

  describe('editor close', () => {
    it('unregisters the session when the document is closed', async () => {
      registry.register(TEMP_PATH, session());

      closeCallback(makeDoc());

      expect(registry.get(TEMP_PATH)).toBeUndefined();
    });
  });
});
