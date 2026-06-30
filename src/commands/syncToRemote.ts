import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { CancellationToken } from 'vscode';
import { PathResolver } from '../path/PathResolver';
import { TransferService } from '../transferService';
import { createTransferService } from '../transferServiceFactory';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { UploadOrchestratorV2 } from '../services/UploadOrchestratorV2';
import { BackupService } from '../services/BackupService';
import { DryRunReporter } from '../services/DryRunReporter';
import { UploadConfirmation } from '../uploadConfirmation';
import { UploadHistoryService } from '../services/UploadHistoryService';
import { summaryToHistoryEntries } from '../services/summaryToHistoryEntries';
import { reconcile, LocalFileEntry, RemoteFileEntry } from '../services/SyncReconciler';
import { walkLocalTree, walkRemoteTree } from '../services/SyncTreeWalker';
import { ProjectConfig, ProjectServer, ServerType } from '../models/ProjectConfig';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

interface ServerConfig {
  rootPath: string;
  mappings: ProjectServer['mappings'];
  excludedPaths: string[];
}

// Server-level facts shared by every sync scope (whole-mapping or folder).
interface SyncServerContext {
  config: ProjectConfig;
  server: ProjectServer;
  serverName: string;
  serverConfig: ServerConfig;
  workspaceRoot: string;
  pathResolver: PathResolver;
  credential: SshCredentialWithSecret;
}

// One sync run's bounds: which local dirs to walk, which remote subtree roots
// bound the walk + deletes, and a display label (server, or "server › folder").
interface SyncScope {
  localRoots: string[];
  remoteRoots: string[];
  label: string;
}

interface DeleteChoiceItem extends vscode.QuickPickItem {
  deleteExtras: boolean;
}

// Directory names never walked on either side: walking them locally would try to
// upload the repo/dependency trees, and walking them remotely would mark them as
// deletable extras. Excluded by default; `excludedPaths` remains the user's tool
// for anything else.
const SYNC_IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/**
 * Sync to Remote (v1): mirror the entire local mapped tree onto the remote,
 * uploading new/newer files and — only when the user opts in per run — pruning
 * remote files that have no local counterpart (delete-extras). Pure comparison
 * lives in {@link reconcile}; this command gathers both trees, presents the
 * delete-extras choice, enforces the destructive-safety gates, and executes via
 * the existing {@link UploadOrchestratorV2}.
 */
export async function syncToRemote(dependencies: Dependencies): Promise<void> {
  const serverContext = await resolveSyncServerContext(dependencies);
  if (!serverContext) {
    return; // error already surfaced
  }

  const { serverName, serverConfig, workspaceRoot, pathResolver } = serverContext;

  // Whole-mapping scope: walk every mapping's local root; bound the remote walk
  // and deletes to the mapped remote roots (safety #5).
  const localRoots = mappingLocalRoots(workspaceRoot, serverConfig);
  const remoteRoots = mappedRemoteRoots(pathResolver, workspaceRoot, serverConfig);

  await runSyncForScope(dependencies, serverContext, { localRoots, remoteRoots, label: serverName });
}

/**
 * Sync Folder to Remote (#21c): run the same reconcile/prune pipeline over one
 * or more selected folders instead of the whole mapping. Delete-extras is
 * confined to the selected folders' remote subtrees, so a folder-sync can never
 * prune anything outside what was right-clicked.
 */
export async function syncFolderToRemote(
  folderPaths: string[],
  dependencies: Dependencies
): Promise<void> {
  if (folderPaths.length === 0) {
    vscode.window.showWarningMessage('FileFerry: No folder selected to sync.');
    return;
  }

  const serverContext = await resolveSyncServerContext(dependencies);
  if (!serverContext) {
    return; // error already surfaced
  }

  const { scope, error } = resolveFolderScope(serverContext, folderPaths);
  if (!scope) {
    vscode.window.showErrorMessage(error ?? 'FileFerry: Could not resolve the sync scope.');
    return;
  }

  await runSyncForScope(dependencies, serverContext, scope);
}

/**
 * Resolves selected folders into a {@link SyncScope}: each folder's remote
 * subtree root (the walk + delete bound) and a labelled scope. Returns an error
 * when a selected folder is under no mapping.
 */
function resolveFolderScope(
  serverContext: SyncServerContext,
  folderPaths: string[]
): { scope?: SyncScope; error?: string } {
  const { pathResolver, workspaceRoot, serverConfig, serverName } = serverContext;
  const localRoots: string[] = [];
  const remoteRoots: string[] = [];

  for (const folderPath of folderPaths) {
    if (localRoots.includes(folderPath)) {
      continue; // duplicate selection
    }
    let remotePath: string;
    try {
      // ignoreExclusions so an excluded *folder name* doesn't block syncing into
      // it; per-file exclusion still applies during the walk.
      remotePath = pathResolver.resolve(folderPath, workspaceRoot, {
        ...serverConfig,
        ignoreExclusions: true,
      }).remotePath;
    } catch {
      const relative = path.relative(workspaceRoot, folderPath) || folderPath;
      return {
        error: `FileFerry: "${relative}" is not under any mapping for "${serverName}". Nothing to sync.`,
      };
    }
    localRoots.push(folderPath);
    remoteRoots.push(remotePath);
  }

  const firstRelative = path.relative(workspaceRoot, localRoots[0]) || '/';
  const label = localRoots.length === 1
    ? `${serverName} › ${firstRelative}`
    : `${serverName} › ${localRoots.length} folders`;

  return { scope: { localRoots, remoteRoots, label } };
}

/**
 * Resolves the project config, default server, credential, and derived helpers
 * shared by every sync scope. Surfaces an error and returns null when there is
 * no config, no default server, or no mappings.
 */
async function resolveSyncServerContext(
  dependencies: Dependencies
): Promise<SyncServerContext | null> {
  const config = await dependencies.configManager.getConfig();
  if (!config) {
    vscode.window.showErrorMessage(
      'FileFerry: No project configuration found. Run "FileFerry: Deployment Settings" to configure.'
    );
    return null;
  }

  const match = await dependencies.configManager.getServerById(config.defaultServerId);
  if (!match) {
    vscode.window.showErrorMessage(
      'FileFerry: Default server not found. Open Deployment Settings to fix.'
    );
    return null;
  }
  const { name: serverName, server } = match;

  if (server.mappings.length === 0) {
    vscode.window.showErrorMessage(
      `FileFerry: No mappings configured for server "${serverName}". Nothing to sync.`
    );
    return null;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const pathResolver = new PathResolver();
  const serverConfig: ServerConfig = {
    rootPath: server.rootPath,
    mappings: server.mappings,
    excludedPaths: server.excludedPaths,
  };
  const credential = await dependencies.credentialManager.getWithSecret(server.credentialId);

  return { config, server, serverName, serverConfig, workspaceRoot, pathResolver, credential };
}

/**
 * The shared sync pipeline for one scope: gather the local files under the
 * scope's roots, walk the bounded remote tree, reconcile, present the
 * delete-extras choice, enforce the destructive-safety gates, and execute via
 * {@link UploadOrchestratorV2}. The whole-mapping and folder-scoped commands
 * differ only in the {@link SyncScope} they pass.
 */
async function runSyncForScope(
  dependencies: Dependencies,
  serverContext: SyncServerContext,
  scope: SyncScope
): Promise<void> {
  const { config, server, serverName, serverConfig, workspaceRoot, pathResolver, credential } =
    serverContext;
  const { localRoots, remoteRoots, label } = scope;

  // Effective hooks (committed + fileferry.local.json) for the confirmation and
  // for execution — set on the server passed to the orchestrator below.
  server.hooks = await dependencies.configManager.getServerHooks(serverName);

  const localFiles = gatherLocalFilesUnder(pathResolver, workspaceRoot, serverConfig, localRoots);

  let plan;
  try {
    plan = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `FileFerry: Comparing "${label}"`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Walking remote tree...' });
        const remoteFiles = await gatherRemoteFiles(credential, server.type, remoteRoots, token);
        return reconcile(localFiles, remoteFiles, {
          timeOffsetMs: server.timeOffsetMs,
          isRemotePathExcluded: makeIsRemotePathExcluded(pathResolver, workspaceRoot, serverConfig),
        });
      }
    );
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`FileFerry: Sync failed: ${(err as Error).message}`);
    return;
  }

  if (plan.toUpload.length === 0 && plan.remoteExtras.length === 0) {
    vscode.window.showInformationMessage(
      `FileFerry: "${label}" is already up to date — ${plan.upToDate.length} file(s) match.`
    );
    return;
  }

  // Delete-extras is an explicit, per-run choice — off by default (safety #1).
  let deleteExtras = false;
  if (plan.remoteExtras.length > 0) {
    const extrasCount = plan.remoteExtras.length;
    const items: DeleteChoiceItem[] = [
      {
        label: '$(cloud-upload) Upload only',
        description: `leave ${extrasCount} remote-only file(s) untouched`,
        deleteExtras: false,
      },
      {
        label: '$(trash) Upload and delete remote extras',
        description: `delete ${extrasCount} remote file(s) not present locally`,
        deleteExtras: true,
      },
    ];
    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: `Sync to "${label}": ${plan.toUpload.length} to upload, ${extrasCount} remote extra(s)`,
    });
    if (!choice) {
      return; // cancelled the QuickPick
    }
    deleteExtras = choice.deleteExtras;
  }

  const deleteRemotePaths = deleteExtras ? plan.remoteExtras : [];

  // Safety #5: a delete path must never fall outside a mapped remote root.
  for (const remotePath of deleteRemotePaths) {
    if (!isUnderAnyRoot(remotePath, remoteRoots)) {
      throw new Error(
        `FileFerry: refusing to delete "${remotePath}" — outside the mapped remote root.`
      );
    }
  }

  // Dry-run-first (safety #2): report the full plan, transfer nothing.
  if (config.dryRun) {
    const reporter = new DryRunReporter(dependencies.output);
    reporter.report([
      { serverName: label, uploadItems: plan.toUpload, deleteRemotePaths, workspaceRoot, hooks: server.hooks },
    ]);
    vscode.window
      .showInformationMessage(
        `FileFerry (dry run): ${plan.toUpload.length} to upload, ${deleteRemotePaths.length} to delete, ` +
          `${plan.upToDate.length} up to date on "${label}".`,
        'Show Log'
      )
      .then(selection => {
        if (selection === 'Show Log') {
          dependencies.output.show();
        }
      });
    return;
  }

  // Confirmation (safety #3): deletes name the count and list the paths.
  const confirmation = new UploadConfirmation(dependencies.context.globalState);
  let confirmed: boolean;
  if (deleteRemotePaths.length > 0) {
    dependencies.output.appendLine(
      `FileFerry (sync): ${deleteRemotePaths.length} remote file(s) to delete on "${label}":`
    );
    for (const remotePath of deleteRemotePaths) {
      dependencies.output.appendLine(`  DELETE  ${remotePath}`);
    }
    confirmed = await confirmation.confirmSyncDeletions(
      label,
      plan.toUpload.length,
      deleteRemotePaths.length,
      server.hooks
    );
  } else {
    confirmed = await confirmation.confirm(server.id, plan.toUpload.length, label, server.hooks);
  }
  if (!confirmed) {
    return;
  }

  const backupBeforeDelete = config.syncBackupBeforeDelete !== false; // default ON
  const backupBeforeOverwrite = !!config.backupBeforeOverwrite; // default OFF
  const orchestrator = new UploadOrchestratorV2();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `FileFerry: Syncing to "${label}"`,
      cancellable: true,
    },
    async (progress, token) => {
      const willBackupOverwrites = backupBeforeOverwrite && plan.toUpload.length > 0;
      const willBackupDeletes = deleteRemotePaths.length > 0 && backupBeforeDelete;

      // One BackupService + a single retention cleanup covers both backup passes.
      const backupService = new BackupService();
      if (willBackupOverwrites || willBackupDeletes) {
        const retentionDays = config.backupRetentionDays ?? 7;
        const maxSizeMB = config.backupMaxSizeMB ?? 100;
        await backupService.cleanup(workspaceRoot, retentionDays, maxSizeMB);
      }

      // Back up remote files we're about to overwrite (matches uploadSelected).
      // BackupService skips files that don't exist remotely, so passing the whole
      // upload set only copies the ones that are genuine overwrites.
      if (willBackupOverwrites) {
        progress.report({ message: 'Backing up remote files before overwrite...' });
        await backupService.backup(plan.toUpload, credential, serverName, workspaceRoot);
      }

      // Back up each to-be-deleted remote file before pruning (safety #4).
      if (willBackupDeletes) {
        progress.report({ message: 'Backing up files before delete...' });
        const backupItems = deleteRemotePaths.map(remotePath => ({ localPath: '', remotePath }));
        await backupService.backup(backupItems, credential, serverName, workspaceRoot);
      }

      progress.report({ message: 'Syncing...' });
      const result = await orchestrator.upload(
        plan.toUpload,
        credential,
        server,
        deleteRemotePaths,
        token,
        {
          workspaceRoot,
          dryRun: !!config.dryRun,
          isTrusted: vscode.workspace.isTrusted,
          output: dependencies.output,
        }
      );

      // A failed pre-deploy hook aborts the sync before anything is transferred.
      if (result.hookAborted) {
        vscode.window.showErrorMessage(
          `FileFerry: Sync to "${label}" aborted — a pre-deploy hook failed. See the FileFerry output for details.`,
          'Show Log'
        ).then(selection => { if (selection === 'Show Log') { dependencies.output.show(); } });
        return;
      }

      const historyMaxEntries = config.historyMaxEntries ?? 10000;
      if (historyMaxEntries > 0) {
        const historyService = new UploadHistoryService(workspaceRoot, historyMaxEntries);
        const entries = summaryToHistoryEntries(result, server.id, serverName, Date.now(), 'sync');
        await historyService.log(entries);
        await historyService.enforceRetention();
      }

      const totalFailed = result.failed.length + result.deleteFailed.length;
      const totalDone = result.succeeded.length + result.deleted.length;

      if (result.cancelled) {
        vscode.window.showWarningMessage(
          `FileFerry: Sync cancelled. ${totalDone} file(s) completed, ${result.cancelled.length} cancelled. ` +
            `Pending deletes were skipped.`
        );
      } else if (totalFailed === 0) {
        vscode.window
          .showInformationMessage(
            `FileFerry: Synced "${label}" — ${result.succeeded.length} uploaded, ` +
              `${result.deleted.length} deleted, ${plan.upToDate.length} up to date.`,
            'Show History'
          )
          .then(selection => {
            if (selection === 'Show History') {
              vscode.commands.executeCommand('fileferry.showUploadHistory');
            }
          });
      } else {
        vscode.window
          .showErrorMessage(
            `FileFerry: Sync to "${label}" — ${totalFailed} failed, ${totalDone} succeeded.`,
            'Show Log',
            'Show History'
          )
          .then(selection => {
            if (selection === 'Show Log') {
              dependencies.output.show();
            }
            if (selection === 'Show History') {
              vscode.commands.executeCommand('fileferry.showUploadHistory');
            }
          });
      }
    }
  );
}

/** Resolves the remote root directory for each mapping (the walk/delete bounds). */
function mappedRemoteRoots(
  pathResolver: PathResolver,
  workspaceRoot: string,
  serverConfig: ServerConfig
): string[] {
  const roots = new Set<string>();
  const mappings = serverConfig.mappings.length > 0
    ? serverConfig.mappings
    : [{ localPath: '/', remotePath: '' }];
  for (const mapping of mappings) {
    const mappingLocalRoot = path.join(workspaceRoot, mapping.localPath.replace(/^\//, ''));
    // Resolve the mapping's local root directory to its remote counterpart.
    // ignoreExclusions so an excluded root dir name doesn't throw here.
    const resolved = pathResolver.resolve(mappingLocalRoot, workspaceRoot, {
      ...serverConfig,
      ignoreExclusions: true,
    });
    roots.add(resolved.remotePath);
  }
  return [...roots];
}

/** The absolute local directory each mapping is rooted at. */
function mappingLocalRoots(workspaceRoot: string, serverConfig: ServerConfig): string[] {
  const mappings = serverConfig.mappings.length > 0
    ? serverConfig.mappings
    : [{ localPath: '/', remotePath: '' }];
  return mappings.map(mapping => path.join(workspaceRoot, mapping.localPath.replace(/^\//, '')));
}

/** Walks each given local root, resolving + stat-ing eligible files. */
function gatherLocalFilesUnder(
  pathResolver: PathResolver,
  workspaceRoot: string,
  serverConfig: ServerConfig,
  localRoots: string[]
): LocalFileEntry[] {
  const entries: LocalFileEntry[] = [];
  const seen = new Set<string>();

  for (const localRoot of localRoots) {
    for (const localPath of walkLocalTree(localRoot, SYNC_IGNORED_DIRECTORY_NAMES)) {
      if (seen.has(localPath)) {
        continue;
      }
      let entry: LocalFileEntry;
      try {
        const remotePath = pathResolver.resolve(localPath, workspaceRoot, serverConfig).remotePath;
        // stat inside the try: a file removed between the walk and here (editor
        // churn, a build, git) is skipped per-file, never aborting the whole run.
        entry = { localPath, remotePath, modifyTimeMs: fs.statSync(localPath).mtimeMs };
      } catch {
        continue; // excluded, unmapped, or vanished — not managed by sync
      }
      seen.add(localPath);
      entries.push(entry);
    }
  }
  return entries;
}

/** Connects once and walks every mapped remote root into a flat file list. */
async function gatherRemoteFiles(
  credential: SshCredentialWithSecret,
  serverType: ServerType,
  remoteRoots: string[],
  token: CancellationToken
): Promise<RemoteFileEntry[]> {
  const transfer: TransferService = createTransferService(serverType);
  await transfer.connect(credential, {
    password: credential.password,
    passphrase: credential.passphrase,
  });
  try {
    const entries: RemoteFileEntry[] = [];
    const seen = new Set<string>();
    for (const remoteRoot of remoteRoots) {
      for (const entry of await walkRemoteTree(transfer, remoteRoot, token, SYNC_IGNORED_DIRECTORY_NAMES)) {
        if (!seen.has(entry.remotePath)) {
          seen.add(entry.remotePath);
          entries.push(entry);
        }
      }
    }
    return entries;
  } finally {
    await transfer.disconnect();
  }
}

/**
 * Builds the exclude-aware predicate (safety #6): a remote path is "excluded"
 * (and so never an extra) when it maps to no managed local path, or its local
 * counterpart would be excluded by `excludedPaths` / `.fileferryignore`.
 */
function makeIsRemotePathExcluded(
  pathResolver: PathResolver,
  workspaceRoot: string,
  serverConfig: ServerConfig
): (remotePath: string) => boolean {
  return (remotePath: string): boolean => {
    const localPath = pathResolver.resolveLocalPath(remotePath, workspaceRoot, serverConfig);
    if (localPath === null) {
      return true; // outside any mapping — unmanaged, never prune
    }
    try {
      pathResolver.resolve(localPath, workspaceRoot, serverConfig);
      return false; // resolves cleanly — a genuine, manageable path
    } catch {
      return true; // excluded (or unmapped) — leave it alone
    }
  };
}

function isUnderAnyRoot(remotePath: string, roots: string[]): boolean {
  return roots.some(root => remotePath === root || remotePath.startsWith(root.replace(/\/$/, '') + '/'));
}
