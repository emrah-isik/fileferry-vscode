import * as vscode from 'vscode';
import { RemoteFileItem } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { validateOctalFileMode } from '../utils/validation';

export interface ChmodRemoteItemDependencies {
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  output: vscode.OutputChannel;
  refresh: () => void;
}

// Changes permissions of files and folders shown in the Remote Files panel
// (feature 33e). One octal prompt ("644", "2775" — the checkbox grid is cut),
// applied to every selected item sequentially. Deliberately NON-recursive on
// folders, and deliberately NO descendant dedupe: unlike delete/move, a
// folder's mode and a child's mode are independent — chmodding both is what
// the user asked for. Chmod logs no history (no bytes move) and never fires
// deploy hooks. On FTP, failures are honest as of this slice: the service
// propagates a rejected SITE CHMOD instead of faking success.
export async function chmodRemoteItem(
  targets: RemoteFileItem[],
  dependencies: ChmodRemoteItemDependencies
): Promise<void> {
  const { connection, configManager, output, refresh } = dependencies;

  if (targets.length === 0) {
    return;
  }
  const entries = targets.map(target => target.entry);
  const isMultiTarget = entries.length > 1;

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

  const rawMode = await vscode.window.showInputBox({
    prompt: isMultiTarget
      ? `Permissions for ${entries.length} items (octal)`
      : `Permissions for ${entries[0].name} (octal)`,
    placeHolder: 'e.g. 644, 755, 2775',
    validateInput: validateOctalFileMode,
  });
  if (rawMode === undefined) {
    return; // cancelled
  }
  const octal = rawMode.trim();
  const mode = parseInt(octal, 8);

  if (config.dryRun) {
    for (const entry of entries) {
      output.appendLine(`[remote-chmod] DRY RUN — would chmod ${octal} ${entry.remotePath} (${serverName})`);
    }
    vscode.window.setStatusBarMessage(
      `$(beaker) Dry run — would chmod ${octal} ${isMultiTarget ? `${entries.length} items` : entries[0].name}`,
      5000
    );
    return;
  }

  if (!isMultiTarget) {
    const entry = entries[0];
    try {
      await connection.chmod(entry.remotePath, mode);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`FileFerry: Failed to change permissions of ${entry.name} — ${message}`);
      return;
    }
    vscode.window.setStatusBarMessage(`$(check) Changed permissions of ${entry.name} to ${octal}`, 3000);
    refresh();
    return;
  }

  const failures: { name: string; message: string }[] = [];
  let changedCount = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Changing permissions of ${entries.length} items to ${octal}...`,
    },
    async (progress) => {
      for (const entry of entries) {
        progress.report({ message: entry.name });
        try {
          await connection.chmod(entry.remotePath, mode);
          changedCount++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ name: entry.name, message });
        }
      }
    }
  );

  if (failures.length > 0) {
    const failureDescriptions = failures.map(failure => `${failure.name}: ${failure.message}`);
    vscode.window.showErrorMessage(
      `FileFerry: Failed to change permissions of ${failures.length} of ${entries.length} items — ${failureDescriptions.join('; ')}`
    );
  }

  if (changedCount > 0) {
    vscode.window.setStatusBarMessage(
      `$(check) Changed permissions of ${changedCount} item${changedCount === 1 ? '' : 's'} to ${octal}`,
      3000
    );
    refresh();
  }
}
