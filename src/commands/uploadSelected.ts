import * as vscode from 'vscode';
import { ScmResourceResolver } from '../scm/ScmResourceResolver';
import { PathResolver, ResolvedUploadItem } from '../path/PathResolver';
import { UploadOrchestratorV2 } from '../services/UploadOrchestratorV2';
import { UploadConfirmation } from '../uploadConfirmation';
import { CredentialManager } from '../storage/CredentialManager';
import { ServerManager } from '../storage/ServerManager';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';

interface Deps {
  credentialManager: CredentialManager;
  serverManager: ServerManager;
  bindingManager: ProjectBindingManager;
  context: vscode.ExtensionContext;
}

export async function uploadSelected(
  primaryResource: vscode.SourceControlResourceState | undefined,
  allResources: vscode.SourceControlResourceState[] | undefined,
  deps: Deps
): Promise<void> {
  const resolver = new ScmResourceResolver();
  const { toUpload, toDelete } = resolver.resolve(primaryResource, allResources);

  if (toUpload.length === 0 && toDelete.length === 0) {
    vscode.window.showWarningMessage('FileFerry: No files selected.');
    return;
  }

  const binding = await deps.bindingManager.getBinding();
  if (!binding) {
    vscode.window.showErrorMessage(
      'FileFerry: No project binding found. Run "FileFerry: Deployment Settings" to configure.'
    );
    return;
  }

  const server = await deps.serverManager.getServer(binding.defaultServerId);
  if (!server) {
    vscode.window.showErrorMessage(
      'FileFerry: Default server not found. Open Deployment Settings to fix.'
    );
    return;
  }

  const serverBinding = binding.servers[server.id];
  if (!serverBinding) {
    vscode.window.showErrorMessage(
      `FileFerry: No mappings configured for server "${server.name}".`
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const pathResolver = new PathResolver();
  const serverConfig = {
    rootPath: server.rootPath,
    rootPathOverride: serverBinding.rootPathOverride,
    mappings: serverBinding.mappings,
    excludedPaths: serverBinding.excludedPaths,
  };

  let uploadItems: ResolvedUploadItem[];
  let deleteRemotePaths: string[];
  try {
    uploadItems = pathResolver.resolveAll(toUpload, workspaceRoot, serverConfig);
    deleteRemotePaths = toDelete.length > 0
      ? pathResolver.resolveAll(toDelete, workspaceRoot, serverConfig).map(item => item.remotePath)
      : [];
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`FileFerry: ${(err as Error).message}`);
    return;
  }

  // Confirmation dialog
  const confirmation = new UploadConfirmation(deps.context.globalState);
  let confirmed: boolean;
  if (deleteRemotePaths.length > 0) {
    confirmed = await confirmation.confirmWithDeletions(server.name, uploadItems.length, deleteRemotePaths.length);
  } else {
    confirmed = await confirmation.confirm(server.id, uploadItems.length);
  }
  if (!confirmed) {
    return;
  }

  const credential = await deps.credentialManager.getWithSecret(server.credentialId);
  const orchestrator = new UploadOrchestratorV2();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `FileFerry: Deploying to "${server.name}"`,
      cancellable: true,
    },
    async (_progress, token) => {
      const result = await orchestrator.upload(uploadItems, credential, server, deleteRemotePaths, token);

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
        vscode.window.showInformationMessage(`FileFerry: ${parts.join(', ')} successfully.`);
      } else {
        vscode.window.showErrorMessage(
          `FileFerry: ${totalFailed} file(s) failed, ${totalSucceeded} succeeded.`,
          'Show Log'
        );
      }
    }
  );
}
