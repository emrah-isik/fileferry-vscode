import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ProjectConfig } from '../models/ProjectConfig';
import { UploadHistoryService } from '../services/UploadHistoryService';
import { UploadHistoryEntry } from '../models/UploadHistoryEntry';
import { walkLocalTree } from '../services/SyncTreeWalker';
import { pickLocalDirectory, pickLocalFiles } from './pickLocalDirectory';

export interface UploadHereDependencies {
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  output: vscode.OutputChannel;
  refresh: () => void;
}

// Upload Files Here… / Upload Folder Here… (feature 33f): put local files at
// the exact remote folder shown in the panel. Deliberately BYPASSES path
// mappings and fileferry.json — this is "put these bytes there", not a
// deploy — and the confirmation says so. No per-file exists() pre-checks
// either (N probes before the first byte, a cd probe each on FTP): the single
// up-front confirmation states that same-named remote files will be
// overwritten, alongside the exact count. Two separate commands because
// Windows/Linux native dialogs cannot offer files and folders together.
//
// Every transferred file logs to Upload History ('remote-upload'); deploy
// hooks never fire.
export async function uploadFilesHere(
  parentPath: string,
  dependencies: UploadHereDependencies
): Promise<void> {
  // In a remote window (WSL/SSH) showOpenDialog degrades to the simple file
  // dialog, which ignores canSelectMany — only one file could ever be picked
  // (manual-pass finding U1). Use the two-step multi-select picker there;
  // desktop windows keep the native OS dialog.
  let localPaths: string[] | undefined;
  if (vscode.env.remoteName !== undefined) {
    localPaths = await pickLocalFiles(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      `Upload files to ${parentPath}`
    );
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Upload',
      title: `Upload files to ${parentPath}`,
      ...defaultDialogLocation(),
    });
    localPaths = picked?.map(fileUri => fileUri.fsPath);
  }
  if (!localPaths || localPaths.length === 0) {
    return; // cancelled
  }

  const uploads = localPaths.map(localPath => ({
    localPath,
    remotePath: joinRemote(parentPath, path.basename(localPath)),
  }));

  await runUploadBatch(uploads, parentPath, [], dependencies);
}

export async function uploadFolderHere(
  parentPath: string,
  dependencies: UploadHereDependencies
): Promise<void> {
  // In a remote window (WSL/SSH) showOpenDialog degrades to the simple file
  // dialog, whose only folder-confirm is the easy-to-miss OK button — no
  // select-this-folder row. Use our own picker there; desktop windows keep
  // the native OS dialog.
  let localFolder: string | undefined;
  if (vscode.env.remoteName !== undefined) {
    localFolder = await pickLocalDirectory(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      `Upload a folder to ${parentPath}`
    );
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Upload',
      title: `Upload a folder to ${parentPath}`,
      ...defaultDialogLocation(),
    });
    localFolder = picked?.[0]?.fsPath;
  }
  if (localFolder === undefined) {
    return; // cancelled
  }
  const folderName = path.basename(localFolder);
  const remoteRoot = joinRemote(parentPath, folderName);

  // No skip-list on purpose (33f L4): if the picked folder contains .git or
  // node_modules, they upload — the count in the confirmation makes a
  // surprise 3,000-file tree visible before anything transfers.
  const localFiles = walkLocalTree(localFolder);
  if (localFiles.length === 0) {
    vscode.window.showInformationMessage(`FileFerry: "${folderName}" contains no files to upload.`);
    return;
  }

  // Remote paths are POSIX; path.relative yields backslashes on Windows, so
  // normalise via the separator split — never a blanket replace.
  const uploads = localFiles.map(localPath => ({
    localPath,
    remotePath: `${remoteRoot}/${path.relative(localFolder, localPath).split(path.sep).join('/')}`,
  }));

  // Parent-first directory skeleton: the remote root, then every subdirectory
  // an upload will land in, shallow to deep.
  const directorySet = new Set<string>([remoteRoot]);
  for (const upload of uploads) {
    let directory = path.posix.dirname(upload.remotePath);
    const missing: string[] = [];
    while (directory !== remoteRoot && !directorySet.has(directory)) {
      missing.push(directory);
      directory = path.posix.dirname(directory);
    }
    for (const missingDirectory of missing.reverse()) {
      directorySet.add(missingDirectory);
    }
  }
  const skeleton = [...directorySet].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
  );

  await runUploadBatch(uploads, remoteRoot, skeleton, dependencies);
}

// Remote paths are POSIX — joined with '/', never path.join.
function joinRemote(parentPath: string, name: string): string {
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
}

// Without a defaultUri, VS Code's dialog falls back to the window's last
// browsed location — which in a remote/WSL window (simple file dialog) is
// often this extension's own fileferry-browse temp dir, left behind by
// edit-session opens. Start at the workspace root instead.
function defaultDialogLocation(): { defaultUri?: vscode.Uri } {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  return workspaceUri !== undefined ? { defaultUri: workspaceUri } : {};
}

async function runUploadBatch(
  uploads: { localPath: string; remotePath: string }[],
  destination: string,
  directorySkeleton: string[],
  dependencies: UploadHereDependencies
): Promise<void> {
  const { connection, configManager, output, refresh } = dependencies;

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
  const fileCount = uploads.length;
  const fileWord = `file${fileCount === 1 ? '' : 's'}`;

  if (config.dryRun) {
    output.appendLine(`[remote-upload] DRY RUN — would upload ${fileCount} ${fileWord} to ${destination} (${serverName})`);
    vscode.window.setStatusBarMessage(`$(beaker) Dry run — would upload ${fileCount} ${fileWord}`, 5000);
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Upload ${fileCount} ${fileWord} to ${destination} on "${serverName}"?`,
    {
      modal: true,
      detail:
        'This bypasses your path mappings and deploy settings — the files go exactly here, and no deploy hooks run. ' +
        'Existing remote files with the same names will be overwritten.',
    },
    'Upload'
  );
  if (choice !== 'Upload') {
    return;
  }

  const failures: { name: string; message: string }[] = [];
  const historyEntries: UploadHistoryEntry[] = [];
  let uploadedCount = 0;
  let remainingCount = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Uploading ${fileCount} ${fileWord} to ${destination}...`,
      cancellable: true,
    },
    async (progress, token) => {
      // Both transports self-heal a missing parent on upload; the skeleton
      // exists so directories appear parent-first and uploads never race the
      // mkdir-retry path. An already-existing directory is fine.
      for (const directory of directorySkeleton) {
        if (token.isCancellationRequested) {
          break;
        }
        try {
          await connection.createDirectory(directory);
        } catch {
          // exists already, or the upload's own retry will surface the error
        }
      }

      for (let index = 0; index < uploads.length; index++) {
        if (token.isCancellationRequested) {
          remainingCount = uploads.length - index;
          break;
        }
        const upload = uploads[index];
        progress.report({ message: path.basename(upload.localPath) });
        try {
          await connection.uploadFile(upload.localPath, upload.remotePath);
          uploadedCount++;
          historyEntries.push(makeHistoryEntry(config, serverName, upload, 'success'));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ name: path.basename(upload.localPath), message });
          historyEntries.push(makeHistoryEntry(config, serverName, upload, 'failed', message));
        }
      }
    }
  );

  await logHistory(config, historyEntries, output);

  if (failures.length > 0) {
    const failureDescriptions = failures.map(failure => `${failure.name}: ${failure.message}`);
    vscode.window.showErrorMessage(
      `FileFerry: Failed to upload ${failures.length} of ${fileCount} ${fileWord} — ${failureDescriptions.join('; ')}`
    );
  }

  if (remainingCount > 0) {
    vscode.window.showInformationMessage(
      `FileFerry: Upload cancelled — ${uploadedCount} of ${fileCount} ${fileWord} uploaded, ${remainingCount} remaining.`
    );
  } else if (uploadedCount > 0) {
    vscode.window.showInformationMessage(
      `FileFerry: Uploaded ${uploadedCount} ${fileWord} to ${destination}`
    );
  }

  if (uploadedCount > 0) {
    refresh();
  }
}

function makeHistoryEntry(
  config: ProjectConfig,
  serverName: string,
  upload: { localPath: string; remotePath: string },
  result: UploadHistoryEntry['result'],
  error?: string
): UploadHistoryEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    serverId: config.defaultServerId!,
    serverName,
    localPath: upload.localPath,
    remotePath: upload.remotePath,
    action: 'upload',
    result,
    ...(error !== undefined ? { error } : {}),
    trigger: 'remote-upload',
  };
}

async function logHistory(
  config: ProjectConfig,
  entries: UploadHistoryEntry[],
  output: vscode.OutputChannel
): Promise<void> {
  // Best-effort: a history failure must never mask completed uploads.
  try {
    if (entries.length === 0) {
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const historyMaxEntries = config.historyMaxEntries ?? 10000;
    if (!workspaceRoot || historyMaxEntries <= 0) {
      return;
    }
    const historyService = new UploadHistoryService(workspaceRoot, historyMaxEntries);
    await historyService.log(entries);
    await historyService.enforceRetention();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[remote-upload] Failed to write upload history: ${message}`);
  }
}
