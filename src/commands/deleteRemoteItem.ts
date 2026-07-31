import * as vscode from 'vscode';
import { RemoteFileItem } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { dropDescendantTargets } from './remoteTargets';

export async function deleteRemoteItem(
  targets: RemoteFileItem[],
  connection: RemoteBrowserConnection,
  refresh: () => void
): Promise<void> {
  // Deleting a selected folder deletes its selected children with it — drop
  // them up front so the confirmed count is honest and no delete can fail on
  // an already-removed path.
  const dedupedTargets = dropDescendantTargets(targets);
  if (dedupedTargets.length === 0) {
    return;
  }

  let confirmationMessage: string;
  if (dedupedTargets.length === 1) {
    const { entry } = dedupedTargets[0];
    const label = entry.type === 'd' ? `folder "${entry.name}"` : `file "${entry.name}"`;
    confirmationMessage = `Are you sure you want to delete ${label} from the server?`;
  } else {
    confirmationMessage = `Delete ${dedupedTargets.length} items from the server?`;
  }

  const confirmed = await vscode.window.showWarningMessage(
    confirmationMessage,
    { modal: true },
    'Delete'
  );

  if (confirmed !== 'Delete') {
    return;
  }

  const failures: { name: string; message: string }[] = [];
  let deletedCount = 0;

  for (const target of dedupedTargets) {
    const { entry } = target;
    try {
      if (entry.type === 'd') {
        await connection.deleteRemoteDirectory(entry.remotePath);
      } else {
        await connection.deleteRemoteFile(entry.remotePath);
      }
      deletedCount++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ name: entry.name, message });
    }
  }

  if (failures.length === 1 && dedupedTargets.length === 1) {
    vscode.window.showErrorMessage(`FileFerry: Failed to delete — ${failures[0].message}`);
  } else if (failures.length > 0) {
    const failureDescriptions = failures.map(failure => `${failure.name}: ${failure.message}`);
    vscode.window.showErrorMessage(
      `FileFerry: Failed to delete ${failures.length} of ${dedupedTargets.length} items — ${failureDescriptions.join('; ')}`
    );
  }

  if (deletedCount > 0) {
    refresh();
  }
}
