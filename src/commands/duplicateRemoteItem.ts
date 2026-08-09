import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { RemoteFileItem, RemoteEntry, formatSize } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ProjectConfig } from '../models/ProjectConfig';
import { UploadHistoryService } from '../services/UploadHistoryService';
import { UploadHistoryEntry } from '../models/UploadHistoryEntry';
import { validateRemoteEntryName } from '../utils/validation';
import { walkRemoteTreeStrict, RemoteTreeSnapshot } from '../services/StrictRemoteTreeWalker';

const TEMP_DIR = path.join(os.tmpdir(), 'fileferry-browse');

// L4: auto-naming in multi mode tries "<stem> copy", then "copy 2".."copy 9",
// then gives up and skips the item — never prompts, never overwrites.
const MAX_COPY_NUMBER = 9;

export interface DuplicateRemoteItemDependencies {
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  output: vscode.OutputChannel;
  refresh: () => void;
}

// The default jest/withProgress mocks call the task without a token, and a
// single-file copy never needs one — treat it as optional everywhere.
type ProgressReporter = { report(value: { message?: string }): void } | undefined;
type CancellationTokenLike = { readonly isCancellationRequested: boolean } | undefined;

// Duplicates remote files and folders shown in the Remote Files panel
// (33c files, widened to folders by 33g). A duplicate composes existing ops
// only: download to a temp file, upload to the sibling path — plus, for
// folders, a strict pre-walk and a recreated directory skeleton (empty
// directories included).
//
// Folder duplicates always confirm once with REAL counts from the pre-walk
// (33g L3 — thresholds are cut); the strict walker ABORTS on any listing
// error, so a blind spot can never become a silently partial copy. There is
// no rollback: cancellation or failure leaves a partial copy, reported
// honestly. Collisions follow the shared rules: single-target file →
// Overwrite/Cancel; single-target folder → abort, never merge; multi mode
// never prompts and never overwrites — auto-names past collisions or skips.
//
// Bytes move, so every copied file logs to Upload History
// ('remote-duplicate', batched into one write), but deploy hooks never fire.
export async function duplicateRemoteItem(
  targets: RemoteFileItem[],
  dependencies: DuplicateRemoteItemDependencies
): Promise<void> {
  const { configManager } = dependencies;

  const entries = targets.map(target => target.entry);
  if (entries.length === 0) {
    return;
  }

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

  if (entries.length > 1) {
    await duplicateMany(entries, serverName, config, dependencies);
    return;
  }

  const entry = entries[0];
  const folderLike = isFolderLike(entry);
  // A symlink to a directory duplicates as the tree it points at (the user
  // clicked a navigable folder row); symlinks INSIDE a tree are skipped.
  const extension = folderLike ? '' : path.posix.extname(entry.name);
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

  if (folderLike) {
    await duplicateSingleFolder(entry, name, newPath, serverName, config, dependencies);
    return;
  }
  await duplicateSingleFile(entry, name, newPath, serverName, config, dependencies);
}

async function duplicateSingleFile(
  entry: RemoteEntry,
  name: string,
  newPath: string,
  serverName: string,
  config: ProjectConfig,
  dependencies: DuplicateRemoteItemDependencies
): Promise<void> {
  const { connection, output, refresh } = dependencies;

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

  const historyEntries: UploadHistoryEntry[] = [];
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Duplicating ${entry.name}...`,
    },
    () => transferRemoteFile(entry.name, entry.remotePath, newPath, dependencies.connection)
  );
  historyEntries.push(makeHistoryEntry(config, serverName, result.tempPath, newPath, result.error));
  await logHistoryBatch(config, historyEntries, output);

  if (result.error !== undefined) {
    vscode.window.showErrorMessage(`FileFerry: Failed to duplicate ${entry.name} — ${result.error}`);
    return;
  }

  vscode.window.setStatusBarMessage(`$(check) Duplicated ${entry.name} → ${name}`, 3000);
  refresh();
}

// 33g single-folder flow: cheap collision check → strict pre-walk → one
// confirmation with real counts → skeleton + per-file copy.
async function duplicateSingleFolder(
  entry: RemoteEntry,
  name: string,
  newPath: string,
  serverName: string,
  config: ProjectConfig,
  dependencies: DuplicateRemoteItemDependencies
): Promise<void> {
  const { connection, output, refresh } = dependencies;

  if (config.dryRun) {
    let snapshot: RemoteTreeSnapshot;
    try {
      snapshot = await scanFolder(entry, connection);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`FileFerry: Failed to scan ${entry.name} — ${message}`);
      return;
    }
    output.appendLine(
      `[remote-duplicate] DRY RUN — would duplicate ${entry.remotePath} → ${newPath} (${describeSnapshot(snapshot)}, ${serverName})`
    );
    vscode.window.setStatusBarMessage(`$(beaker) Dry run — would duplicate ${entry.name}`, 5000);
    return;
  }

  let snapshot: RemoteTreeSnapshot;
  try {
    const targetType = await connection.statRemoteType(newPath);
    if (targetType !== null) {
      vscode.window.showErrorMessage(
        `FileFerry: "${name}" already exists here — folders are never overwritten or merged.`
      );
      return;
    }
    // The walker throws on ANY listing error — abort before a single write,
    // never a silently partial copy (33g L2).
    snapshot = await scanFolder(entry, connection);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to duplicate ${entry.name} — ${message}`);
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Duplicate "${entry.name}" → "${name}" — ${describeSnapshot(snapshot)}?`,
    {
      modal: true,
      detail: confirmationDetail(snapshot),
    },
    'Duplicate'
  );
  if (confirmed !== 'Duplicate') {
    return;
  }

  const historyEntries: UploadHistoryEntry[] = [];
  const outcome = { copied: 0, remaining: 0, failures: [] as { label: string; message: string }[] };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Duplicating ${snapshot.files.length} file${snapshot.files.length === 1 ? '' : 's'}...`,
      cancellable: true,
    },
    async (progress, token) => {
      const result = await copyFolderTree(
        entry.remotePath, newPath, snapshot, serverName, config, dependencies.connection,
        historyEntries, progress, token
      );
      outcome.copied = result.copied;
      outcome.remaining = result.remaining;
      outcome.failures = result.failures;
    }
  );

  await logHistoryBatch(config, historyEntries, output);
  reportFolderOutcome(outcome, snapshot.files.length, `${entry.name} → ${name}`);
  // The skeleton was written the moment the copy started — always refresh.
  refresh();
}

// Multi mode (33c files + 33g folders): never prompts for names, never
// overwrites. A selection containing folders confirms ONCE with aggregate
// pre-walk counts — the recursive copy is the expensive part the confirmation
// exists for; a pure-file selection keeps the 33c prompt-free behaviour.
async function duplicateMany(
  entries: RemoteEntry[],
  serverName: string,
  config: ProjectConfig,
  dependencies: DuplicateRemoteItemDependencies
): Promise<void> {
  const { connection, output, refresh } = dependencies;
  const folderEntries = entries.filter(isFolderLike);

  const snapshots = new Map<string, RemoteTreeSnapshot>();
  if (folderEntries.length > 0) {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `Scanning ${folderEntries.length} folder${folderEntries.length === 1 ? '' : 's'}...`,
        },
        async () => {
          for (const folderEntry of folderEntries) {
            snapshots.set(folderEntry.remotePath, await walkRemoteTreeStrict(connection, folderEntry.remotePath));
          }
        }
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`FileFerry: Failed to scan the selected folders — ${message}`);
      return;
    }
  }

  if (config.dryRun) {
    for (const entry of entries) {
      const basePath = siblingPath(entry.remotePath, copyName(entry, 1));
      const snapshot = snapshots.get(entry.remotePath);
      const countNote = snapshot !== undefined ? `${snapshot.files.length} files, ` : '';
      output.appendLine(
        `[remote-duplicate] DRY RUN — would duplicate ${entry.remotePath} → ${basePath} (auto-named, ${countNote}${serverName})`
      );
    }
    vscode.window.setStatusBarMessage(`$(beaker) Dry run — would duplicate ${entries.length} items`, 5000);
    return;
  }

  if (folderEntries.length > 0) {
    const walkedFiles = [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.files.length, 0);
    const directFileEntries = entries.filter(entry => !isFolderLike(entry));
    const totalFiles = walkedFiles + directFileEntries.length;
    const totalBytes =
      [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.totalBytes, 0) +
      directFileEntries.reduce((sum, entry) => sum + entry.size, 0);
    const allSymlinks = [...snapshots.values()].flatMap(snapshot => snapshot.symlinks);

    const confirmed = await vscode.window.showWarningMessage(
      `Duplicate ${entries.length} items — ${totalFiles} file${totalFiles === 1 ? '' : 's'}, ${formatSize(totalBytes)}` +
        `${allSymlinks.length > 0 ? ` (${allSymlinks.length} symlink${allSymlinks.length === 1 ? '' : 's'} skipped)` : ''}?`,
      {
        modal: true,
        detail: confirmationDetail({ symlinks: allSymlinks }),
      },
      'Duplicate'
    );
    if (confirmed !== 'Duplicate') {
      return;
    }
  }

  const historyEntries: UploadHistoryEntry[] = [];
  const failures: { label: string; message: string }[] = [];
  const skippedNames: string[] = [];
  let copiedCount = 0;
  let remainingCount = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Duplicating ${entries.length} ${folderEntries.length > 0 ? 'items' : 'files'}...`,
      cancellable: true,
    },
    async (progress, token: CancellationTokenLike) => {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (token?.isCancellationRequested) {
          remainingCount += entries.slice(index).reduce((sum, remaining) => sum + plannedFileCount(remaining, snapshots), 0);
          break;
        }
        progress.report({ message: entry.name });

        let newPath: string | null = null;
        try {
          newPath = await findAvailableCopyPath(entry, connection);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ label: entry.name, message });
          continue;
        }
        if (newPath === null) {
          skippedNames.push(entry.name);
          continue;
        }

        if (isFolderLike(entry)) {
          const snapshot = snapshots.get(entry.remotePath)!;
          const result = await copyFolderTree(
            entry.remotePath, newPath, snapshot, serverName, config, connection,
            historyEntries, progress, token
          );
          copiedCount += result.copied;
          remainingCount += result.remaining;
          failures.push(...result.failures);
        } else {
          const result = await transferRemoteFile(entry.name, entry.remotePath, newPath, connection);
          historyEntries.push(makeHistoryEntry(config, serverName, result.tempPath, newPath, result.error));
          if (result.error !== undefined) {
            failures.push({ label: entry.name, message: result.error });
          } else {
            copiedCount++;
          }
        }
      }
    }
  );

  await logHistoryBatch(config, historyEntries, output);

  if (failures.length > 0) {
    const failureDescriptions = failures.map(failure => `${failure.label}: ${failure.message}`);
    vscode.window.showErrorMessage(
      `FileFerry: Failed to duplicate ${failures.length} of ${entries.length} ${folderEntries.length > 0 ? 'items' : 'files'} — ${failureDescriptions.join('; ')}`
    );
  }

  if (copiedCount > 0 || skippedNames.length > 0 || remainingCount > 0) {
    let message = remainingCount > 0
      ? `FileFerry: Duplicate cancelled — ${copiedCount} file${copiedCount === 1 ? '' : 's'} copied, ${remainingCount} remaining.`
      : `FileFerry: Duplicated ${copiedCount} file${copiedCount === 1 ? '' : 's'}`;
    if (skippedNames.length > 0) {
      message += ` (skipped — no free copy name: ${skippedNames.join(', ')})`;
    }
    vscode.window.showInformationMessage(message);
  }

  if (copiedCount > 0) {
    refresh();
  }
}

// ── shared mechanics ────────────────────────────────────────────────────────

function isFolderLike(entry: RemoteEntry): boolean {
  return entry.type === 'd' || (entry.type === 'l' && entry.symlinkTarget === 'd');
}

// "<stem> copy<ext>" for files; folders have no extension concept, so the
// whole name is the stem ("v1.2" → "v1.2 copy", never "v1 copy.2").
function copyName(entry: RemoteEntry, copyNumber: number): string {
  const extension = isFolderLike(entry) ? '' : path.posix.extname(entry.name);
  const stem = entry.name.slice(0, entry.name.length - extension.length);
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
    const candidatePath = siblingPath(entry.remotePath, copyName(entry, copyNumber));
    if (!(await connection.exists(candidatePath))) {
      return candidatePath;
    }
  }
  return null;
}

// How many file copies an entry represents — 1 for a plain file, the walked
// count for a folder. Used to report the remainder honestly on cancellation.
function plannedFileCount(entry: RemoteEntry, snapshots: Map<string, RemoteTreeSnapshot>): number {
  return isFolderLike(entry) ? snapshots.get(entry.remotePath)?.files.length ?? 0 : 1;
}

async function scanFolder(entry: RemoteEntry, connection: RemoteBrowserConnection): Promise<RemoteTreeSnapshot> {
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Scanning ${entry.name}...` },
    () => walkRemoteTreeStrict(connection, entry.remotePath)
  );
}

function describeSnapshot(snapshot: RemoteTreeSnapshot): string {
  const fileWord = `file${snapshot.files.length === 1 ? '' : 's'}`;
  const base = `${snapshot.files.length} ${fileWord}, ${formatSize(snapshot.totalBytes)}`;
  return snapshot.symlinks.length > 0
    ? `${base} (${snapshot.symlinks.length} symlink${snapshot.symlinks.length === 1 ? '' : 's'} skipped)`
    : base;
}

function confirmationDetail(snapshot: { symlinks: string[] }): string {
  const partialNote = 'Cancellation or a failure leaves a partial copy — nothing is rolled back.';
  if (snapshot.symlinks.length === 0) {
    return partialNote;
  }
  return `Symlinks are never copied:\n${snapshot.symlinks.join('\n')}\n\n${partialNote}`;
}

// Skeleton (root + every directory, empty ones included, parent-first), then
// the per-file download→temp→upload loop. Cancellable per iteration; failures
// are collected per SOURCE path (the summary must name them, 33g L5).
async function copyFolderTree(
  sourceRoot: string,
  destinationRoot: string,
  snapshot: RemoteTreeSnapshot,
  serverName: string,
  config: ProjectConfig,
  connection: RemoteBrowserConnection,
  historyEntries: UploadHistoryEntry[],
  progress: ProgressReporter,
  token: CancellationTokenLike
): Promise<{ copied: number; remaining: number; failures: { label: string; message: string }[] }> {
  const failures: { label: string; message: string }[] = [];
  let copied = 0;
  let remaining = 0;

  for (const directory of [destinationRoot, ...snapshot.directories.map(d => destinationRoot + d.slice(sourceRoot.length))]) {
    if (token?.isCancellationRequested) {
      break;
    }
    try {
      await connection.createDirectory(directory);
    } catch {
      // best effort — the file uploads self-heal a genuinely missing parent
    }
  }

  for (let index = 0; index < snapshot.files.length; index++) {
    if (token?.isCancellationRequested) {
      remaining = snapshot.files.length - index;
      break;
    }
    const file = snapshot.files[index];
    const fileName = path.posix.basename(file.remotePath);
    progress?.report({ message: fileName });

    const destinationPath = destinationRoot + file.remotePath.slice(sourceRoot.length);
    const result = await transferRemoteFile(fileName, file.remotePath, destinationPath, connection);
    historyEntries.push(makeHistoryEntry(config, serverName, result.tempPath, destinationPath, result.error));
    if (result.error !== undefined) {
      failures.push({ label: file.remotePath, message: result.error });
    } else {
      copied++;
    }
  }

  return { copied, remaining, failures };
}

function reportFolderOutcome(
  outcome: { copied: number; remaining: number; failures: { label: string; message: string }[] },
  totalFiles: number,
  label: string
): void {
  if (outcome.failures.length > 0) {
    const failureDescriptions = outcome.failures.map(failure => `${failure.label}: ${failure.message}`);
    vscode.window.showErrorMessage(
      `FileFerry: Failed to copy ${outcome.failures.length} of ${totalFiles} files — ${failureDescriptions.join('; ')}`
    );
  }
  if (outcome.remaining > 0) {
    vscode.window.showInformationMessage(
      `FileFerry: Duplicate cancelled — ${outcome.copied} of ${totalFiles} files copied, ${outcome.remaining} remaining.`
    );
  } else if (outcome.failures.length === 0) {
    vscode.window.setStatusBarMessage(`$(check) Duplicated ${label}`, 3000);
  }
}

// Download → temp file → upload. The temp streams the bytes through disk so
// the copy composes the two existing transfer ops; always unlinked.
async function transferRemoteFile(
  sourceName: string,
  sourceRemotePath: string,
  destinationPath: string,
  connection: RemoteBrowserConnection
): Promise<{ tempPath: string; error?: string }> {
  const hash = crypto.createHash('md5').update(sourceRemotePath).digest('hex').slice(0, 8);
  const tempPath = path.join(TEMP_DIR, `${sourceName}.duplicate.${hash}`);

  try {
    const content = await connection.downloadFile(sourceRemotePath);
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.writeFile(tempPath, content);
    await connection.uploadFile(tempPath, destinationPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { tempPath, error: message };
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch {
      // best effort — a stray temp copy is harmless
    }
  }
  return { tempPath };
}

function makeHistoryEntry(
  config: ProjectConfig,
  serverName: string,
  localPath: string,
  remotePath: string,
  error?: string
): UploadHistoryEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    serverId: config.defaultServerId!,
    serverName,
    localPath,
    remotePath,
    action: 'upload',
    result: error !== undefined ? 'failed' : 'success',
    ...(error !== undefined ? { error } : {}),
    trigger: 'remote-duplicate',
  };
}

async function logHistoryBatch(
  config: ProjectConfig,
  entries: UploadHistoryEntry[],
  output: vscode.OutputChannel
): Promise<void> {
  // Best-effort: a history failure must never mask a completed duplicate.
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
    output.appendLine(`[remote-duplicate] Failed to write upload history: ${message}`);
  }
}
