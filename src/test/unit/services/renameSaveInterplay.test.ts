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
import { RemoteEditSaveListener } from '../../../services/RemoteEditSaveListener';
import { RemoteEditSessionRegistry, RemoteEditSession } from '../../../services/RemoteEditSessionRegistry';
import { renameRemoteItem } from '../../../commands/renameRemoteItem';
import { RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

/**
 * Interplay pin for feature 33b (ruling C2): renaming a remote entry while an
 * edit session is open on it must redirect the NEXT SAVE to the new path.
 *
 * Without the rewrite, the save listener would stat the old path, find nothing,
 * conclude "deleted on the server", and — after "Upload Anyway" — recreate the
 * file under its OLD name. These tests drive the real rename command and the
 * real save listener over one shared registry, pinning that the save uploads
 * to the new path and never even stats the old one.
 */

const TEMP_PATH = path.join('/tmp', 'fileferry-browse', 'index.remote.abc123.php');
const DOWNLOADED_CONTENT = Buffer.from('<?php echo "original";');
const DOWNLOADED_SHA256 = crypto.createHash('sha256').update(DOWNLOADED_CONTENT).digest('hex');
const BASE_MTIME_MS = new Date('2026-07-31T10:00:00Z').getTime();
const EDITED_CONTENT = Buffer.from('<?php echo "edited";');

const mockConnection = {
  // save-listener surface
  statRemote: jest.fn(),
  downloadFile: jest.fn(),
  uploadFile: jest.fn(),
  // rename-command surface
  statRemoteType: jest.fn(),
  rename: jest.fn(),
  deleteRemoteFile: jest.fn(),
  getCurrentServerId: jest.fn(),
};

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
};

const mockOutput = { appendLine: jest.fn(), show: jest.fn() };
const mockRefresh = jest.fn();

const mockHistoryLog = jest.fn();
const mockHistoryEnforceRetention = jest.fn();
(UploadHistoryService as unknown as jest.Mock).mockImplementation(() => ({
  log: mockHistoryLog,
  enforceRetention: mockHistoryEnforceRetention,
}));

const server = {
  id: 'server-1', type: 'sftp' as const,
  credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/var/www', mappings: [], excludedPaths: [],
};
const baseConfig = { defaultServerId: 'server-1', servers: { Production: server }, dryRun: false };

let saveCallback: (doc: unknown) => Promise<void>;

function makeDoc(fsPath: string = TEMP_PATH) {
  return { uri: { fsPath } };
}

function session(overrides: Partial<RemoteEditSession> = {}): RemoteEditSession {
  return {
    serverId: 'server-1',
    remotePath: '/var/www/index.php',
    downloadedMtimeMs: BASE_MTIME_MS,
    sha256: DOWNLOADED_SHA256,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RemoteEntry> & { name: string; remotePath: string }): RemoteEntry {
  return {
    type: '-',
    size: 1024,
    modifyTime: 1710000000000,
    ...overrides,
  };
}

describe('rename → save interplay (C2)', () => {
  let registry: RemoteEditSessionRegistry;

  function renameDependencies() {
    return {
      connection: mockConnection as any,
      configManager: mockConfigManager as any,
      registry,
      output: mockOutput as any,
      refresh: mockRefresh,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new RemoteEditSessionRegistry();

    (vscode.workspace.onDidSaveTextDocument as jest.Mock).mockImplementation((callback: any) => {
      saveCallback = callback;
      return { dispose: jest.fn() };
    });
    (vscode.workspace.onDidCloseTextDocument as jest.Mock).mockImplementation(() => ({ dispose: jest.fn() }));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.window.withProgress as jest.Mock).mockImplementation(
      (_options: any, task: (progress: any) => Promise<any>) => task({ report: jest.fn() })
    );
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockImplementation(async (id: string) =>
      id === 'server-1' ? { name: 'Production', server } : undefined
    );
    mockConnection.statRemote.mockResolvedValue({ mtime: new Date(BASE_MTIME_MS) });
    mockConnection.downloadFile.mockResolvedValue(DOWNLOADED_CONTENT);
    mockConnection.uploadFile.mockResolvedValue(undefined);
    mockConnection.statRemoteType.mockResolvedValue(null);
    mockConnection.rename.mockResolvedValue(undefined);
    mockConnection.deleteRemoteFile.mockResolvedValue(undefined);
    mockConnection.getCurrentServerId.mockReturnValue('server-1');
    mockHistoryLog.mockResolvedValue(undefined);
    mockHistoryEnforceRetention.mockResolvedValue(undefined);
    (fs.readFile as jest.Mock).mockResolvedValue(EDITED_CONTENT);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

    const listener = new RemoteEditSaveListener({
      registry,
      connection: mockConnection as any,
      configManager: mockConfigManager as any,
      output: mockOutput as any,
    });
    listener.register();
  });

  it('after renaming an open file, save uploads to the NEW path and never stats the old one', async () => {
    registry.register(TEMP_PATH, session({ remotePath: '/var/www/index.php' }));
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('home.php');

    await renameRemoteItem(
      makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' }),
      renameDependencies()
    );
    await saveCallback(makeDoc());

    expect(mockConnection.uploadFile).toHaveBeenCalledWith(TEMP_PATH, '/var/www/home.php', { interactive: true });
    // The old path must never be consulted — a stat there would report
    // "deleted on server" and recreate the file under the old name.
    for (const call of mockConnection.statRemote.mock.calls) {
      expect(call[0]).not.toBe('/var/www/index.php');
    }
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('after renaming a folder, an open file inside it saves to its path under the NEW folder', async () => {
    const tempPath = path.join('/tmp', 'fileferry-browse', 'config.remote.def456.php');
    registry.register(tempPath, session({ remotePath: '/var/www/app/config.php' }));
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('site');

    await renameRemoteItem(
      makeEntry({ name: 'app', type: 'd', size: 4096, remotePath: '/var/www/app' }),
      renameDependencies()
    );
    await saveCallback(makeDoc(tempPath));

    expect(mockConnection.uploadFile).toHaveBeenCalledWith(tempPath, '/var/www/site/config.php', { interactive: true });
    for (const call of mockConnection.statRemote.mock.calls) {
      expect(call[0]).not.toBe('/var/www/app/config.php');
    }
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('a session on an unrelated file is untouched by the rename and saves to its own path', async () => {
    const tempPath = path.join('/tmp', 'fileferry-browse', 'other.remote.fed321.php');
    registry.register(tempPath, session({ remotePath: '/var/www/other.php' }));
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('home.php');

    await renameRemoteItem(
      makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' }),
      renameDependencies()
    );
    await saveCallback(makeDoc(tempPath));

    expect(mockConnection.uploadFile).toHaveBeenCalledWith(tempPath, '/var/www/other.php', { interactive: true });
  });
});
