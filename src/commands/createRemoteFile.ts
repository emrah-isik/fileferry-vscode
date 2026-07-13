import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { RemoteEditSessionRegistry } from '../services/RemoteEditSessionRegistry';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ProjectConfig } from '../models/ProjectConfig';
import { UploadHistoryService } from '../services/UploadHistoryService';
import { UploadHistoryEntry } from '../models/UploadHistoryEntry';
import { validateRemoteEntryName } from '../utils/validation';
import { openRemoteFile } from './openRemoteFile';

const TEMP_DIR = path.join(os.tmpdir(), 'fileferry-browse');

export interface CreateRemoteFileDependencies {
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  registry: RemoteEditSessionRegistry;
  output: vscode.OutputChannel;
  refresh: () => void;
}

// Creates an empty file in a remote directory shown in the Remote Files panel
// (feature 32b). The create is a zero-byte upload through the existing
// connection.uploadFile — no new transport — and the created file is then
// opened through openRemoteFile, so it lands on 32a's edit-session path:
// create → type → save → uploaded works end to end.
//
// Deliberately does NOT go through UploadOrchestratorV2: deploy hooks (#27)
// run only for deliberate deploys, and a panel create is a single-file write.
export async function createRemoteFile(
  parentPath: string,
  dependencies: CreateRemoteFileDependencies
): Promise<void> {
  const { connection, configManager, registry, output, refresh } = dependencies;

  const rawName = await vscode.window.showInputBox({
    prompt: `New file in ${parentPath}`,
    placeHolder: 'File name',
    validateInput: validateRemoteEntryName,
  });
  if (rawName === undefined) {
    return; // cancelled
  }
  const name = rawName.trim();
  // Remote paths are POSIX — joined with '/', never path.join.
  const remotePath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;

  const config = await configManager.getConfig();
  if (!config || !config.defaultServerId) {
    vscode.window.showErrorMessage('FileFerry: No server configured. Open Deployment Settings to add one.');
    return;
  }
  const match = await configManager.getServerById(config.defaultServerId);
  if (!match) {
    vscode.window.showErrorMessage('FileFerry: Server not found. It may have been deleted.');
    return;
  }
  const serverName = match.name;

  if (config.dryRun) {
    output.appendLine(`[remote-create] DRY RUN — would create ${remotePath} (${serverName})`);
    vscode.window.setStatusBarMessage(`$(beaker) Dry run — would create ${name}`, 5000);
    return;
  }

  try {
    const alreadyExists = await connection.exists(remotePath);
    if (alreadyExists) {
      const choice = await vscode.window.showWarningMessage(
        `${name} already exists in ${parentPath} on "${serverName}".`,
        {
          modal: true,
          detail: 'Overwriting will replace the remote file with an empty one.',
        },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        return;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to create ${name} — ${message}`);
    return;
  }

  const hash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
  const tempPath = path.join(TEMP_DIR, `${name}.create.${hash}`);

  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.writeFile(tempPath, '');
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating ${name} on ${serverName}...`,
      },
      () => connection.uploadFile(tempPath, remotePath)
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logHistory(config, serverName, tempPath, remotePath, output, 'failed', message);
    vscode.window.showErrorMessage(`FileFerry: Failed to create ${name} — ${message}`);
    return;
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch {
      // best effort — a stray zero-byte temp is harmless
    }
  }

  await logHistory(config, serverName, tempPath, remotePath, output, 'success');
  vscode.window.setStatusBarMessage(`$(check) Created ${name} on ${serverName}`, 3000);
  refresh();

  const syntheticEntry: RemoteEntry = {
    name,
    type: '-',
    size: 0,
    modifyTime: Date.now(),
    remotePath,
  };
  await openRemoteFile(syntheticEntry, connection, registry);
}

async function logHistory(
  config: ProjectConfig,
  serverName: string,
  localPath: string,
  remotePath: string,
  output: vscode.OutputChannel,
  result: UploadHistoryEntry['result'],
  error?: string
): Promise<void> {
  // Best-effort: a history failure must never mask a completed create.
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const historyMaxEntries = config.historyMaxEntries ?? 10000;
    if (!workspaceRoot || historyMaxEntries <= 0) {
      return;
    }
    const historyService = new UploadHistoryService(workspaceRoot, historyMaxEntries);
    await historyService.log([{
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      serverId: config.defaultServerId!,
      serverName,
      localPath,
      remotePath,
      action: 'upload',
      result,
      ...(error !== undefined ? { error } : {}),
      trigger: 'remote-create',
    }]);
    await historyService.enforceRetention();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[remote-create] Failed to write upload history: ${message}`);
  }
}
