import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { PathResolver } from '../path/PathResolver';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';
import { ServerManager } from '../storage/ServerManager';

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
  bindingManager: ProjectBindingManager,
  serverManager: ServerManager
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('FileFerry: No workspace open.');
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const binding = await bindingManager.getBinding();
  if (!binding?.defaultServerId) {
    vscode.window.showErrorMessage('FileFerry: No project binding found. Open Deployment Settings to configure.');
    return;
  }

  const server = await serverManager.getServer(binding.defaultServerId);
  if (!server) {
    vscode.window.showErrorMessage('FileFerry: Default server not found.');
    return;
  }

  const serverBinding = binding.servers?.[server.id];
  const resolver = new PathResolver();
  const localPath = resolver.resolveLocalPath(entry.remotePath, workspaceRoot, {
    rootPath: server.rootPath,
    rootPathOverride: serverBinding?.rootPathOverride,
    mappings: serverBinding?.mappings ?? [],
    excludedPaths: serverBinding?.excludedPaths ?? [],
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
