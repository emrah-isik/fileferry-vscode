import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { RemoteFileItem, RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ProjectConfig } from '../models/ProjectConfig';
import { UploadHistoryService } from '../services/UploadHistoryService';
import { UploadHistoryEntry } from '../models/UploadHistoryEntry';
import { validateRemoteEntryName } from '../utils/validation';

const TEMP_DIR = path.join(os.tmpdir(), 'fileferry-browse');

// L4: auto-naming in multi mode tries "<stem> copy", then "copy 2".."copy 9",
// then gives up and skips the file — never prompts, never overwrites.
const MAX_COPY_NUMBER = 9;

export interface DuplicateRemoteItemDependencies {
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  output: vscode.OutputChannel;
  refresh: () => void;
}

// Duplicates remote files shown in the Remote Files panel (feature 33c).
// A duplicate composes existing ops only: download to a temp file, upload to
// the sibling path — no server-side copy primitive. Selection-aware from day
// one; 33g widens the same command to folders.
//
// Single target: input box prefilled "<stem> copy<ext>", and an explicit-name
// collision follows the shared 33b L3 pattern (file → Overwrite/Cancel,
// folder → abort, never merge). Multi target: NEVER prompts and NEVER
// overwrites — auto-names past collisions, or skips and reports.
//
// Bytes move, so every file logs to Upload History ('remote-duplicate'), but
// deploy hooks never fire — a panel duplicate is not a deploy.
export async function duplicateRemoteItem(
  targets: RemoteFileItem[],
  dependencies: DuplicateRemoteItemDependencies
): Promise<void> {
  const { connection, configManager, output, refresh } = dependencies;

  // The command is offered on files only, but stay defensive about folders —
  // and about the recursion 33g will add later, which this slice doesn't have.
  const fileTargets = targets.filter(
    target => target.entry.type !== 'd' && !(target.entry.type === 'l' && target.entry.symlinkTarget === 'd')
  );
  const skippedFolderCount = targets.length - fileTargets.length;
  if (fileTargets.length === 0) {
    return;
  }
  const isMultiTarget = targets.length > 1;

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

  if (isMultiTarget) {
    await duplicateMany(fileTargets.map(target => target.entry), skippedFolderCount, serverName, config, dependencies);
    return;
  }

  const entry = fileTargets[0].entry;
  const extension = path.posix.extname(entry.name);
  const stem = entry.name.slice(0, entry.name.length - extension.length);
  const defaultName = `${stem} copy${extension}`;

  const rawName = await vscode.window.showInputBox({
    prompt: `Duplicate ${entry.name}`,
    value: defaultName,
    valueSelection: [0, defaultName.length - extension.length],
    validateInput: validateRemoteEntryName,
  });
  if (rawName === undefined) {
    return; // cancelled
  }
  const name = rawName.trim();
  if (name === entry.name) {
    return; // a duplicate under the source's own name is meaningless — no-op
  }
  const newPath = siblingPath(entry.remotePath, name);

  if (config.dryRun) {
    output.appendLine(`[remote-duplicate] DRY RUN — would duplicate ${entry.remotePath} → ${newPath} (${serverName})`);
    vscode.window.setStatusBarMessage(`$(beaker) Dry run — would duplicate ${entry.name}`, 5000);
    return;
  }

  try {
    const targetType = await connection.statRemoteType(newPath);
    if (targetType === 'd') {
      vscode.window.showErrorMessage(
        `FileFerry: A folder named "${name}" already exists here — folders are never overwritten or merged.`
      );
      return;
    }
    if (targetType !== null) {
      const choice = await vscode.window.showWarningMessage(
        `${name} already exists on "${serverName}".`,
        {
          modal: true,
          detail: `Overwriting will replace the remote file with a copy of "${entry.name}".`,
        },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        return;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to duplicate ${entry.name} — ${message}`);
    return;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Duplicating ${entry.name}...`,
    },
    () => copyRemoteFile(entry, newPath, serverName, config, connection, output)
  );

  if (result.error !== undefined) {
    vscode.window.showErrorMessage(`FileFerry: Failed to duplicate ${entry.name} — ${result.error}`);
    return;
  }

  vscode.window.setStatusBarMessage(`$(check) Duplicated ${entry.name} → ${name}`, 3000);
  refresh();
}

// Multi-target path (L4/L5): sequential under one notification, auto-named,
// no prompts, aggregated failures, one refresh at the end.
async function duplicateMany(
  entries: RemoteEntry[],
  skippedFolderCount: number,
  serverName: string,
  config: ProjectConfig,
  dependencies: DuplicateRemoteItemDependencies
): Promise<void> {
  const { connection, output, refresh } = dependencies;

  if (config.dryRun) {
    for (const entry of entries) {
      const basePath = siblingPath(entry.remotePath, copyName(entry.name, 1));
      output.appendLine(
        `[remote-duplicate] DRY RUN — would duplicate ${entry.remotePath} → ${basePath} (auto-named, ${serverName})`
      );
    }
    vscode.window.setStatusBarMessage(`$(beaker) Dry run — would duplicate ${entries.length} files`, 5000);
    return;
  }

  const failures: { name: string; message: string }[] = [];
  const skippedNames: string[] = [];
  let duplicatedCount = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Duplicating ${entries.length} files...`,
    },
    async (progress) => {
      for (const entry of entries) {
        progress.report({ message: entry.name });

        let newPath: string | null = null;
        try {
          newPath = await findAvailableCopyPath(entry, connection);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ name: entry.name, message });
          continue;
        }
        if (newPath === null) {
          skippedNames.push(entry.name);
          continue;
        }

        const result = await copyRemoteFile(entry, newPath, serverName, config, connection, output);
        if (result.error !== undefined) {
          failures.push({ name: entry.name, message: result.error });
        } else {
          duplicatedCount++;
        }
      }
    }
  );

  if (failures.length > 0) {
    const failureDescriptions = failures.map(failure => `${failure.name}: ${failure.message}`);
    vscode.window.showErrorMessage(
      `FileFerry: Failed to duplicate ${failures.length} of ${entries.length} files — ${failureDescriptions.join('; ')}`
    );
  }

  if (duplicatedCount > 0 || skippedNames.length > 0 || skippedFolderCount > 0) {
    let message = `FileFerry: Duplicated ${duplicatedCount} file${duplicatedCount === 1 ? '' : 's'}`;
    if (skippedNames.length > 0) {
      message += ` (skipped — no free copy name: ${skippedNames.join(', ')})`;
    }
    if (skippedFolderCount > 0) {
      message += ` (${skippedFolderCount} folder${skippedFolderCount === 1 ? '' : 's'} skipped — folders can't be duplicated yet)`;
    }
    vscode.window.showInformationMessage(message);
  }

  if (duplicatedCount > 0) {
    refresh();
  }
}

// "<stem> copy<ext>", "<stem> copy 2<ext>", … "<stem> copy 9<ext>".
function copyName(sourceName: string, copyNumber: number): string {
  const extension = path.posix.extname(sourceName);
  const stem = sourceName.slice(0, sourceName.length - extension.length);
  return copyNumber === 1 ? `${stem} copy${extension}` : `${stem} copy ${copyNumber}${extension}`;
}

// Remote paths are POSIX — joined with '/', never path.join.
function siblingPath(remotePath: string, name: string): string {
  const parentPath = path.posix.dirname(remotePath);
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
}

// One exists() probe per attempt, sequential; null when every name is taken.
async function findAvailableCopyPath(
  entry: RemoteEntry,
  connection: RemoteBrowserConnection
): Promise<string | null> {
  for (let copyNumber = 1; copyNumber <= MAX_COPY_NUMBER; copyNumber++) {
    const candidatePath = siblingPath(entry.remotePath, copyName(entry.name, copyNumber));
    if (!(await connection.exists(candidatePath))) {
      return candidatePath;
    }
  }
  return null;
}

// Download → temp file → upload. The temp streams the bytes through disk so
// the copy composes the two existing transfer ops; always unlinked. Logs the
// history row (success or failure) itself so both callers stay uniform.
async function copyRemoteFile(
  entry: RemoteEntry,
  newPath: string,
  serverName: string,
  config: ProjectConfig,
  connection: RemoteBrowserConnection,
  output: vscode.OutputChannel
): Promise<{ error?: string }> {
  const hash = crypto.createHash('md5').update(entry.remotePath).digest('hex').slice(0, 8);
  const tempPath = path.join(TEMP_DIR, `${entry.name}.duplicate.${hash}`);

  try {
    const content = await connection.downloadFile(entry.remotePath);
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.writeFile(tempPath, content);
    await connection.uploadFile(tempPath, newPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logHistory(config, serverName, tempPath, newPath, output, 'failed', message);
    return { error: message };
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch {
      // best effort — a stray temp copy is harmless
    }
  }

  await logHistory(config, serverName, tempPath, newPath, output, 'success');
  return {};
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
  // Best-effort: a history failure must never mask a completed duplicate.
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
      trigger: 'remote-duplicate',
    }]);
    await historyService.enforceRetention();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[remote-duplicate] Failed to write upload history: ${message}`);
  }
}
