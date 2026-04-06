import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { PathResolver } from '../path/PathResolver';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

export async function downloadToWorkspace(
  entry: RemoteEntry,
  connection: RemoteBrowserConnection,
  configManager: ProjectConfigManager
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('FileFerry: No workspace open.');
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // Resolve local path via reverse path mapping
  let localPath: string | null = null;
  const config = await configManager.getConfig();
  if (config?.defaultServerId) {
    const match = await configManager.getServerById(config.defaultServerId);
    if (match) {
      const { server } = match;
      const resolver = new PathResolver();
      localPath = resolver.resolveLocalPath(entry.remotePath, workspaceRoot, {
        rootPath: server.rootPath,
        mappings: server.mappings,
        excludedPaths: server.excludedPaths,
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
