import * as vscode from 'vscode';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { validateRemoteEntryName } from '../utils/validation';

export interface CreateRemoteFolderDependencies {
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  output: vscode.OutputChannel;
  refresh: () => void;
}

// Creates a folder in a remote directory shown in the Remote Files panel
// (feature 32b). A name collision ABORTS with a visible error — silently
// merging into an existing folder is too surprising (locked decision). Folder
// creates are not logged to upload history: they are neither an upload nor a
// delete, and widening the action union for them is out of scope for v1 (L2).
export async function createRemoteFolder(
  parentPath: string,
  dependencies: CreateRemoteFolderDependencies
): Promise<void> {
  const { connection, configManager, output, refresh } = dependencies;

  const rawName = await vscode.window.showInputBox({
    prompt: `New folder in ${parentPath}`,
    placeHolder: 'Folder name',
    validateInput: validateRemoteEntryName,
  });
  if (rawName === undefined) {
    return; // cancelled
  }
  const name = rawName.trim();
  // Remote paths are POSIX — joined with '/', never path.join.
  const remotePath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;

  const config = await configManager.getConfig();
  if (!config || !config.defaultServerId) {
    vscode.window.showErrorMessage('FileFerry: No server configured. Open Deployment Settings to add one.');
    return;
  }
  const match = await configManager.getServerById(config.defaultServerId);
  if (!match) {
    vscode.window.showErrorMessage('FileFerry: Server not found. It may have been deleted.');
    return;
  }
  const serverName = match.name;

  if (config.dryRun) {
    output.appendLine(`[remote-create] DRY RUN — would create ${remotePath}/ (${serverName})`);
    vscode.window.setStatusBarMessage(`$(beaker) Dry run — would create ${name}`, 5000);
    return;
  }

  try {
    const alreadyExists = await connection.exists(remotePath);
    if (alreadyExists) {
      vscode.window.showErrorMessage(
        `FileFerry: "${name}" already exists in ${parentPath} on "${serverName}" — nothing was created.`
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating folder ${name} on ${serverName}...`,
      },
      () => connection.createDirectory(remotePath)
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to create folder ${name} — ${message}`);
    return;
  }

  vscode.window.setStatusBarMessage(`$(check) Created folder ${name} on ${serverName}`, 3000);
  refresh();
}
