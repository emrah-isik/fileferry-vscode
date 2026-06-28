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
import { ProjectServer, ServerType } from '../models/ProjectConfig';
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
  const config = await dependencies.configManager.getConfig();
  if (!config) {
    vscode.window.showErrorMessage(
      'FileFerry: No project configuration found. Run "FileFerry: Deployment Settings" to configure.'
    );
    return;
  }

  const match = await dependencies.configManager.getServerById(config.defaultServerId);
  if (!match) {
    vscode.window.showErrorMessage(
      'FileFerry: Default server not found. Open Deployment Settings to fix.'
    );
    return;
  }
  const { name: serverName, server } = match;

  if (server.mappings.length === 0) {
    vscode.window.showErrorMessage(
      `FileFerry: No mappings configured for server "${serverName}". Nothing to sync.`
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const pathResolver = new PathResolver();
  const serverConfig: ServerConfig = {
    rootPath: server.rootPath,
    mappings: server.mappings,
    excludedPaths: server.excludedPaths,
  };

  // The mapped remote roots — used to bound the remote walk AND to guard deletes
  // so a prune can never escape the mapping (safety #5).
  const remoteRoots = mappedRemoteRoots(pathResolver, workspaceRoot, serverConfig);

  const localFiles = gatherLocalFiles(pathResolver, workspaceRoot, serverConfig);

  const credential = await dependencies.credentialManager.getWithSecret(server.credentialId);

  let plan;
  try {
    plan = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `FileFerry: Comparing "${serverName}"`,
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
      `FileFerry: "${serverName}" is already up to date — ${plan.upToDate.length} file(s) match.`
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
      placeHolder: `Sync to "${serverName}": ${plan.toUpload.length} to upload, ${extrasCount} remote extra(s)`,
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
      { serverName, uploadItems: plan.toUpload, deleteRemotePaths, workspaceRoot },
    ]);
    vscode.window
      .showInformationMessage(
        `FileFerry (dry run): ${plan.toUpload.length} to upload, ${deleteRemotePaths.length} to delete, ` +
          `${plan.upToDate.length} up to date on "${serverName}".`,
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
      `FileFerry (sync): ${deleteRemotePaths.length} remote file(s) to delete on "${serverName}":`
    );
    for (const remotePath of deleteRemotePaths) {
      dependencies.output.appendLine(`  DELETE  ${remotePath}`);
    }
    confirmed = await confirmation.confirmSyncDeletions(
      serverName,
      plan.toUpload.length,
      deleteRemotePaths.length
    );
  } else {
    confirmed = await confirmation.confirm(server.id, plan.toUpload.length, serverName);
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
      title: `FileFerry: Syncing to "${serverName}"`,
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
        token
      );

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
            `FileFerry: Synced "${serverName}" — ${result.succeeded.length} uploaded, ` +
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
            `FileFerry: Sync to "${serverName}" — ${totalFailed} failed, ${totalDone} succeeded.`,
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

/** Walks every mapping's local root, resolving + stat-ing eligible files. */
function gatherLocalFiles(
  pathResolver: PathResolver,
  workspaceRoot: string,
  serverConfig: ServerConfig
): LocalFileEntry[] {
  const entries: LocalFileEntry[] = [];
  const seen = new Set<string>();
  const mappings = serverConfig.mappings.length > 0
    ? serverConfig.mappings
    : [{ localPath: '/', remotePath: '' }];

  for (const mapping of mappings) {
    const mappingLocalRoot = path.join(workspaceRoot, mapping.localPath.replace(/^\//, ''));
    for (const localPath of walkLocalTree(mappingLocalRoot, SYNC_IGNORED_DIRECTORY_NAMES)) {
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
