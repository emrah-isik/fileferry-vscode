import * as vscode from 'vscode';
import * as path from 'path';
import { ScmResourceResolver } from '../scm/ScmResourceResolver';
import { PathResolver, ResolvedUploadItem } from '../path/PathResolver';
import { UploadOrchestratorV2, UploadSummaryV2 } from '../services/UploadOrchestratorV2';
import { FileDateGuard } from '../services/FileDateGuard';
import { BackupService } from '../services/BackupService';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ProjectServer } from '../models/ProjectConfig';
import { DryRunReporter } from '../services/DryRunReporter';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

interface ServerQuickPickItem extends vscode.QuickPickItem {
  serverId: string;
}

interface ServerUploadResult {
  serverName: string;
  summary?: UploadSummaryV2;
  error?: string;
}

export async function uploadToServers(
  primaryResource: vscode.SourceControlResourceState | undefined,
  allResources: vscode.SourceControlResourceState[] | undefined,
  dependencies: Dependencies
): Promise<void> {
  // Fall back to active editor when invoked via keybinding with no SCM selection
  if (!primaryResource && !allResources) {
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    if (editorUri) {
      primaryResource = { resourceUri: editorUri } as vscode.SourceControlResourceState;
    }
  }

  const resolver = new ScmResourceResolver();
  const { toUpload, toDelete } = resolver.resolve(primaryResource, allResources);

  if (toUpload.length === 0 && toDelete.length === 0) {
    vscode.window.showWarningMessage('FileFerry: No files selected.');
    return;
  }

  const config = await dependencies.configManager.getConfig();
  if (!config) {
    vscode.window.showErrorMessage(
      'FileFerry: No project configuration found. Run "FileFerry: Deployment Settings" to configure.'
    );
    return;
  }

  const serverEntries = Object.entries(config.servers);
  if (serverEntries.length === 0) {
    vscode.window.showErrorMessage(
      'FileFerry: No servers configured. Open Deployment Settings to add servers.'
    );
    return;
  }

  // Show multi-select QuickPick
  const items: ServerQuickPickItem[] = serverEntries.map(([name, server]) => ({
    label: name,
    serverId: server.id,
    description: server.id === config.defaultServerId ? '(default)' : undefined,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select target servers for upload',
  });

  if (!selected || selected.length === 0) {
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const fileDateGuardEnabled = config.fileDateGuard !== false;
  const backupEnabled = !!config.backupBeforeOverwrite;

  // Build per-server upload plans (path resolution only — no SFTP yet)
  type ServerPlan = {
    serverName: string;
    server: ProjectServer;
    uploadItems: ResolvedUploadItem[];
    deleteRemotePaths: string[];
  };

  const plans: ServerPlan[] = [];

  for (const pick of selected) {
    const entry = serverEntries.find(([, s]) => s.id === pick.serverId);
    if (!entry) { continue; }
    const [serverName, server] = entry;

    if (server.mappings.length === 0) {
      continue;
    }

    const pathResolver = new PathResolver();
    const serverConfig = {
      rootPath: server.rootPath,
      mappings: server.mappings,
      excludedPaths: server.excludedPaths,
    };

    try {
      const uploadItems = pathResolver.resolveAll(toUpload, workspaceRoot, serverConfig);
      const deleteRemotePaths = toDelete.length > 0
        ? pathResolver.resolveAll(toDelete, workspaceRoot, serverConfig).map(item => item.remotePath)
        : [];

      plans.push({ serverName, server, uploadItems, deleteRemotePaths });
    } catch (err: unknown) {
      const message = (err as Error).message;
      vscode.window.showErrorMessage(`FileFerry: ${serverName}: ${message}`);
    }
  }

  if (plans.length === 0) {
    return;
  }

  // Dry run intercept — report all server plans and skip all transfers
  if (config.dryRun) {
    const reporter = new DryRunReporter(dependencies.output);
    reporter.report(plans.map(p => ({
      serverName: p.serverName,
      uploadItems: p.uploadItems,
      deleteRemotePaths: p.deleteRemotePaths,
      workspaceRoot,
    })));
    const totalUploads = plans.reduce((sum, p) => sum + p.uploadItems.length, 0);
    const totalDeletes = plans.reduce((sum, p) => sum + p.deleteRemotePaths.length, 0);
    vscode.window.showInformationMessage(
      `FileFerry (dry run): ${totalUploads} file(s) to upload, ${totalDeletes} to delete across ${plans.length} server(s).`,
      'Show Log'
    ).then(choice => { if (choice === 'Show Log') { dependencies.output.show(); } });
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `FileFerry: Deploying to ${plans.length} server(s)`,
      cancellable: true,
    },
    async (progress, token) => {
      // File date guard per server
      if (fileDateGuardEnabled) {
        progress.report({ message: 'Checking remote files...' });
        const approvedPlans: ServerPlan[] = [];
        for (const plan of plans) {
          if (plan.uploadItems.length > 0) {
            const credential = await dependencies.credentialManager.getWithSecret(plan.server.credentialId);
            const newerOnRemote = await new FileDateGuard().check(plan.uploadItems, credential, plan.server.timeOffsetMs);
            if (newerOnRemote.length > 0) {
              const fileNames = newerOnRemote.map(f => path.basename(f.localPath)).join(', ');
              const choice = await vscode.window.showWarningMessage(
                `FileFerry: ${newerOnRemote.length} file(s) newer on "${plan.serverName}": ${fileNames}`,
                'Overwrite'
              );
              if (choice !== 'Overwrite') {
                continue; // Skip this server
              }
            }
          }
          approvedPlans.push(plan);
        }
        plans.length = 0;
        plans.push(...approvedPlans);
      }

      if (plans.length === 0) {
        return;
      }

      // Backup before overwrite: cleanup once, then backup per server
      if (backupEnabled) {
        progress.report({ message: 'Backing up remote files...' });
        const retentionDays = config.backupRetentionDays ?? 7;
        const maxSizeMB = config.backupMaxSizeMB ?? 100;
        const backupService = new BackupService();
        await backupService.cleanup(workspaceRoot, retentionDays, maxSizeMB);
        for (const plan of plans) {
          if (plan.uploadItems.length > 0) {
            const backupCredential = await dependencies.credentialManager.getWithSecret(plan.server.credentialId);
            await backupService.backup(plan.uploadItems, backupCredential, plan.serverName, workspaceRoot);
          }
        }
      }

      progress.report({ message: 'Uploading...' });
      const results: ServerUploadResult[] = await Promise.all(
        plans.map(async (plan): Promise<ServerUploadResult> => {
          try {
            const credential = await dependencies.credentialManager.getWithSecret(plan.server.credentialId);
            const orchestrator = new UploadOrchestratorV2();
            const summary = await orchestrator.upload(
              plan.uploadItems, credential, plan.server, plan.deleteRemotePaths, token
            );
            return { serverName: plan.serverName, summary };
          } catch (err: unknown) {
            return {
              serverName: plan.serverName,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })
      );

      // Aggregate results
      const succeeded: ServerUploadResult[] = [];
      const failed: ServerUploadResult[] = [];
      let anyCancelled = false;

      for (const result of results) {
        if (result.error) {
          failed.push(result);
        } else if (result.summary) {
          const totalFailed = result.summary.failed.length + result.summary.deleteFailed.length;
          if (totalFailed > 0) {
            failed.push(result);
          } else {
            succeeded.push(result);
          }
          if (result.summary.cancelled && result.summary.cancelled.length > 0) {
            anyCancelled = true;
          }
        }
      }

      if (anyCancelled) {
        const totalDone = results.reduce((sum, r) =>
          sum + (r.summary?.succeeded.length ?? 0) + (r.summary?.deleted.length ?? 0), 0);
        const totalCancelled = results.reduce((sum, r) =>
          sum + (r.summary?.cancelled?.length ?? 0), 0);
        vscode.window.showWarningMessage(
          `FileFerry: Transfer cancelled. ${totalDone} file(s) completed, ${totalCancelled} cancelled.`
        );
      } else if (failed.length === 0) {
        const totalFiles = results.reduce((sum, r) =>
          sum + (r.summary?.succeeded.length ?? 0) + (r.summary?.deleted.length ?? 0), 0);
        vscode.window.showInformationMessage(
          `FileFerry: ${totalFiles} file(s) deployed to ${succeeded.length} server(s) successfully.`
        );
      } else if (succeeded.length === 0) {
        const failNames = failed.map(f => f.serverName).join(', ');
        vscode.window.showErrorMessage(
          `FileFerry: All servers failed: ${failNames}`,
          'Show Log'
        );
      } else {
        const succNames = succeeded.map(s => s.serverName).join(', ');
        const failNames = failed.map(f => f.serverName).join(', ');
        vscode.window.showErrorMessage(
          `FileFerry: Succeeded: ${succNames}. Failed: ${failNames}`,
          'Show Log'
        );
      }
    }
  );
}
