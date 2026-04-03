import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { PathResolver } from '../path/PathResolver';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';
import { ServerManager } from '../storage/ServerManager';

export async function downloadToWorkspace(
  entry: RemoteEntry,
  connection: RemoteBrowserConnection,
  bindingManager: ProjectBindingManager,
  serverManager: ServerManager
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('FileFerry: No workspace open.');
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // Resolve local path via reverse path mapping
  let localPath: string | null = null;
  const binding = await bindingManager.getBinding();
  if (binding?.defaultServerId) {
    const server = await serverManager.getServer(binding.defaultServerId);
    if (server) {
      const serverBinding = binding.servers?.[server.id];
      const resolver = new PathResolver();
      localPath = resolver.resolveLocalPath(entry.remotePath, workspaceRoot, {
        rootPath: server.rootPath,
        rootPathOverride: serverBinding?.rootPathOverride,
        mappings: serverBinding?.mappings ?? [],
        excludedPaths: serverBinding?.excludedPaths ?? [],
      });
    }
  }

  // If no mapping matched, prompt for save location
  if (!localPath) {
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(workspaceRoot, entry.name)),
      filters: { 'All Files': ['*'] },
    });
    if (!saveUri) {
      return;
    }
    localPath = saveUri.fsPath;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Downloading ${entry.name}...` },
    async () => {
      const content = await connection.downloadFile(entry.remotePath);
      await fs.mkdir(path.dirname(localPath!), { recursive: true });
      await fs.writeFile(localPath!, content);
    }
  );

  const relativePath = path.relative(workspaceRoot, localPath);
  vscode.window.showInformationMessage(`FileFerry: Downloaded to ${relativePath}`);
}
