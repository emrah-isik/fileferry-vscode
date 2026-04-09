import * as vscode from 'vscode';
import * as path from 'path';
import { ScmResourceResolver } from '../scm/ScmResourceResolver';
import { PathResolver, ResolvedUploadItem } from '../path/PathResolver';
import { UploadOrchestratorV2 } from '../services/UploadOrchestratorV2';
import { FileDateGuard } from '../services/FileDateGuard';
import { BackupService } from '../services/BackupService';
import { UploadConfirmation } from '../uploadConfirmation';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { DryRunReporter } from '../services/DryRunReporter';
import { UploadHistoryService } from '../services/UploadHistoryService';
import { summaryToHistoryEntries } from '../services/summaryToHistoryEntries';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

export async function uploadSelected(
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
      `FileFerry: No mappings configured for server "${serverName}".`
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const pathResolver = new PathResolver();
  const serverConfig = {
    rootPath: server.rootPath,
    mappings: server.mappings,
    excludedPaths: server.excludedPaths,
  };

  let uploadItems: ResolvedUploadItem[];
  let deleteRemotePaths: string[];
  try {
    uploadItems = pathResolver.resolveAll(toUpload, workspaceRoot, serverConfig);
    deleteRemotePaths = toDelete.length > 0
      ? pathResolver.resolveAll(toDelete, workspaceRoot, serverConfig).map(item => item.remotePath)
      : [];
  } catch (err: unknown) {
    const message = (err as Error).message;
    // Offer force-upload when a file is excluded by ignore patterns
    if (message.startsWith('File is excluded:')) {
      const choice = await vscode.window.showWarningMessage(
        `FileFerry: ${message}`,
        'Upload Anyway'
      );
      if (choice === 'Upload Anyway') {
        const forceConfig = { ...serverConfig, ignoreExclusions: true };
        uploadItems = pathResolver.resolveAll(toUpload, workspaceRoot, forceConfig);
        deleteRemotePaths = toDelete.length > 0
          ? pathResolver.resolveAll(toDelete, workspaceRoot, forceConfig).map(item => item.remotePath)
          : [];
      } else {
        return;
      }
    } else {
      vscode.window.showErrorMessage(`FileFerry: ${message}`);
      return;
    }
  }

  // Dry run intercept — report plan and skip all transfers
  if (config.dryRun) {
    const reporter = new DryRunReporter(dependencies.output);
    reporter.report([{ serverName, uploadItems, deleteRemotePaths, workspaceRoot }]);
    vscode.window.showInformationMessage(
      `FileFerry (dry run): ${uploadItems.length} file(s) to upload, ${deleteRemotePaths.length} to delete on "${serverName}".`,
      'Show Log'
    ).then(choice => { if (choice === 'Show Log') { dependencies.output.show(); } });
    return;
  }

  // Confirmation dialog
  const confirmation = new UploadConfirmation(dependencies.context.globalState);
  let confirmed: boolean;
  if (deleteRemotePaths.length > 0) {
    confirmed = await confirmation.confirmWithDeletions(serverName, uploadItems.length, deleteRemotePaths.length);
  } else {
    confirmed = await confirmation.confirm(server.id, uploadItems.length);
  }
  if (!confirmed) {
    return;
  }

  const credential = await dependencies.credentialManager.getWithSecret(server.credentialId);
  const fileDateGuardEnabled = config.fileDateGuard !== false;

  const orchestrator = new UploadOrchestratorV2();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `FileFerry: Deploying to "${serverName}"`,
      cancellable: true,
    },
    async (progress, token) => {
      // File date guard: warn if remote files are newer than local
      if (fileDateGuardEnabled) {
        progress.report({ message: 'Checking remote files...' });
        const newerOnRemote = await new FileDateGuard().check(uploadItems, credential, server.timeOffsetMs);
        if (newerOnRemote.length > 0) {
          const fileNames = newerOnRemote.map(f => path.basename(f.localPath)).join(', ');
          const choice = await vscode.window.showWarningMessage(
            `FileFerry: ${newerOnRemote.length} file(s) newer on the remote: ${fileNames}`,
            'Overwrite'
          );
          if (choice !== 'Overwrite') {
            return;
          }
        }
      }

      // Backup before overwrite: download remote files to local backup
      if (config.backupBeforeOverwrite) {
        progress.report({ message: 'Backing up remote files...' });
        const retentionDays = config.backupRetentionDays ?? 7;
        const maxSizeMB = config.backupMaxSizeMB ?? 100;
        const backupService = new BackupService();
        await backupService.cleanup(workspaceRoot, retentionDays, maxSizeMB);
        await backupService.backup(uploadItems, credential, serverName, workspaceRoot);
      }

      progress.report({ message: 'Uploading...' });
      const result = await orchestrator.upload(uploadItems, credential, server, deleteRemotePaths, token);

      // Log upload history
      const historyMaxEntries = config.historyMaxEntries ?? 10000;
      if (historyMaxEntries > 0) {
        const historyService = new UploadHistoryService(workspaceRoot, historyMaxEntries);
        const historyEntries = summaryToHistoryEntries(result, server.id, serverName, Date.now(), 'manual');
        await historyService.log(historyEntries);
        await historyService.enforceRetention();
      }

      const totalFailed = result.failed.length + result.deleteFailed.length;
      const totalSucceeded = result.succeeded.length + result.deleted.length;

      if (result.cancelled) {
        const cancelledCount = result.cancelled.length;
        const doneCount = totalSucceeded;
        vscode.window.showWarningMessage(
          `FileFerry: Transfer cancelled. ${doneCount} file(s) completed, ${cancelledCount} cancelled.`
        );
      } else if (totalFailed === 0) {
        const parts: string[] = [];
        if (result.succeeded.length > 0) {
          parts.push(`${result.succeeded.length} file(s) uploaded`);
        }
        if (result.deleted.length > 0) {
          parts.push(`${result.deleted.length} file(s) deleted`);
        }
        vscode.window.showInformationMessage(
          `FileFerry: ${parts.join(', ')} successfully.`,
          'Show History'
        ).then(choice => { if (choice === 'Show History') { vscode.commands.executeCommand('fileferry.showUploadHistory'); } });
      } else {
        vscode.window.showErrorMessage(
          `FileFerry: ${totalFailed} file(s) failed, ${totalSucceeded} succeeded.`,
          'Show Log',
          'Show History'
        ).then(choice => {
          if (choice === 'Show Log') { dependencies.output.show(); }
          if (choice === 'Show History') { vscode.commands.executeCommand('fileferry.showUploadHistory'); }
        });
      }
    }
  );
}
