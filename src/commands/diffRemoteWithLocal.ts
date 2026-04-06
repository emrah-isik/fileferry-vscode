import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { PathResolver } from '../path/PathResolver';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

const TEMP_DIR = path.join(os.tmpdir(), 'fileferry-diff');

function getTempPath(remotePath: string): string {
  const hash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
  const ext = path.extname(remotePath);
  const base = path.basename(remotePath, ext);
  return path.join(TEMP_DIR, `${base}.remote.${hash}${ext}`);
}

export async function diffRemoteWithLocal(
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

  const config = await configManager.getConfig();
  if (!config?.defaultServerId) {
    vscode.window.showErrorMessage('FileFerry: No project configuration found. Open Deployment Settings to configure.');
    return;
  }

  const match = await configManager.getServerById(config.defaultServerId);
  if (!match) {
    vscode.window.showErrorMessage('FileFerry: Default server not found.');
    return;
  }

  const { server } = match;
  const resolver = new PathResolver();
  const localPath = resolver.resolveLocalPath(entry.remotePath, workspaceRoot, {
    rootPath: server.rootPath,
    mappings: server.mappings,
    excludedPaths: server.excludedPaths,
  });

  if (!localPath) {
    vscode.window.showErrorMessage(`FileFerry: No local file mapping found for ${entry.remotePath}.`);
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Comparing ${entry.name}...` },
    async () => {
      const content = await connection.downloadFile(entry.remotePath);
      const tempPath = getTempPath(entry.remotePath);
      await fs.mkdir(TEMP_DIR, { recursive: true });
      await fs.writeFile(tempPath, content);

      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(tempPath),
        vscode.Uri.file(localPath),
        `${entry.name} (Remote) ↔ ${entry.name} (Local)`
      );
    }
  );
}
