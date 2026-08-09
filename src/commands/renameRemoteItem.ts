import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { RemoteEditSessionRegistry } from '../services/RemoteEditSessionRegistry';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { validateRemoteEntryName } from '../utils/validation';

export interface RenameRemoteItemDependencies {
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  registry: RemoteEditSessionRegistry;
  output: vscode.OutputChannel;
  refresh: () => void;
}

// Renames a file or folder shown in the Remote Files panel (feature 33b).
// Single-target by design: acts on the clicked/focused item, like Compare
// with Local. The collision handling is the shared pattern later ops inherit
// (33b L3): an existing file target prompts Overwrite/Cancel — Overwrite is
// delete-then-rename, uniform across SFTP/FTP — while an existing folder
// target always aborts; folders are never overwritten or merged.
//
// After a successful rename, open edit sessions pointing at the old path are
// rebound to the new one (ruling C2) so their next save uploads to where the
// file now lives instead of recreating it under the old name. Renames log no
// history (no bytes move) and never fire deploy hooks.
export async function renameRemoteItem(
  entry: RemoteEntry,
  dependencies: RenameRemoteItemDependencies
): Promise<void> {
  const { connection, configManager, registry, output, refresh } = dependencies;

  // The provider's disconnected/error placeholder rows carry an empty path.
  if (entry.remotePath === '') {
    return;
  }

  // Select just the stem so typing replaces the name but keeps the extension.
  // Directories have no extension concept — select the whole name.
  const extension = entry.type === 'd' ? '' : path.posix.extname(entry.name);
  const rawName = await vscode.window.showInputBox({
    prompt: `Rename ${entry.name}`,
    value: entry.name,
    valueSelection: [0, entry.name.length - extension.length],
    validateInput: validateRemoteEntryName,
  });
  if (rawName === undefined) {
    return; // cancelled
  }
  const name = rawName.trim();
  if (name === entry.name) {
    return; // unchanged — silent no-op
  }

  const oldPath = entry.remotePath;
  const parentPath = path.posix.dirname(oldPath);
  // Remote paths are POSIX — joined with '/', never path.join.
  const newPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;

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
    output.appendLine(`[remote-rename] DRY RUN — would rename ${oldPath} → ${newPath} (${serverName})`);
    vscode.window.setStatusBarMessage(`$(beaker) Dry run — would rename ${entry.name}`, 5000);
    return;
  }

  // Once the colliding target is deleted, the server no longer matches the
  // panel — refresh even if the rename itself then fails.
  let deletedCollidingTarget = false;
  try {
    const targetType = await connection.statRemoteType(newPath);
    if (targetType === 'd') {
      vscode.window.showErrorMessage(
        `FileFerry: A folder named "${name}" already exists in ${parentPath} — folders are never overwritten or merged.`
      );
      return;
    }
    if (targetType !== null) {
      const choice = await vscode.window.showWarningMessage(
        `${name} already exists in ${parentPath} on "${serverName}".`,
        {
          modal: true,
          detail: `Overwriting will replace the remote file with "${entry.name}".`,
        },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        return;
      }
      await connection.deleteRemoteFile(newPath);
      deletedCollidingTarget = true;
    }

    await connection.rename(oldPath, newPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to rename ${entry.name} — ${message}`);
    if (deletedCollidingTarget) {
      refresh();
    }
    return;
  }

  // Rebind open edit sessions to the new path (C2) — exact match rewrites a
  // renamed file's own session; the prefix match inside rewriteRemotePath
  // carries sessions on files INSIDE a renamed folder along with it.
  const serverId = connection.getCurrentServerId() ?? config.defaultServerId;
  registry.rewriteRemotePath(serverId, oldPath, newPath);

  vscode.window.setStatusBarMessage(`$(check) Renamed ${entry.name} → ${name}`, 3000);
  refresh();
}
