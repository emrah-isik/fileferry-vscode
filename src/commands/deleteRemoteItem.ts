import * as vscode from 'vscode';
import { RemoteFileItem } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';

export async function deleteRemoteItem(
  item: RemoteFileItem,
  connection: RemoteBrowserConnection,
  refresh: () => void
): Promise<void> {
  const { entry } = item;
  const isDir = entry.type === 'd';
  const label = isDir ? `folder "${entry.name}"` : `file "${entry.name}"`;

  const confirmed = await vscode.window.showWarningMessage(
    `Are you sure you want to delete ${label} from the server?`,
    { modal: true },
    'Delete'
  );

  if (confirmed !== 'Delete') {
    return;
  }

  try {
    if (isDir) {
      await connection.deleteRemoteDirectory(entry.remotePath);
    } else {
      await connection.deleteRemoteFile(entry.remotePath);
    }
    refresh();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to delete — ${message}`);
  }
}
