import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../path/PathResolver';
import { DiffService } from '../diffService';
import { SftpService } from '../sftpService';
import { CredentialManager } from '../storage/CredentialManager';
import { ServerManager } from '../storage/ServerManager';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';

interface Deps {
  credentialManager: CredentialManager;
  serverManager: ServerManager;
  bindingManager: ProjectBindingManager;
}

export async function showRemoteDiff(
  resource: vscode.SourceControlResourceState | undefined,
  deps: Deps
): Promise<void> {
  if (!resource) {
    vscode.window.showErrorMessage('FileFerry: No file selected.');
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

  const localPath = resource.resourceUri.fsPath;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const pathResolver = new PathResolver();

  let remotePath: string;
  try {
    const resolved = pathResolver.resolve(localPath, workspaceRoot, {
      rootPath: server.rootPath,
      rootPathOverride: serverBinding.rootPathOverride,
      mappings: serverBinding.mappings,
      excludedPaths: serverBinding.excludedPaths,
    });
    remotePath = resolved.remotePath;
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`FileFerry: ${(err as Error).message}`);
    return;
  }

  const credential = await deps.credentialManager.getWithSecret(server.credentialId);
  const tempDir = path.join(os.tmpdir(), 'fileferry');
  const diffService = new DiffService(new SftpService(), tempDir);
  const fileName = path.basename(localPath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `FileFerry: Fetching remote "${fileName}" from "${server.name}"`,
      cancellable: false,
    },
    async () => {
      let tempPath: string;
      try {
        tempPath = await diffService.downloadRemoteFile(
          credential as any,
          { password: credential.password, passphrase: credential.passphrase },
          remotePath
        );
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`FileFerry: ${(err as Error).message}`);
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(tempPath),
        resource.resourceUri,
        `${fileName} (Remote: ${server.name}) ↔ ${fileName} (Local)`
      );
    }
  );
}
