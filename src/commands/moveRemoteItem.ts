import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteFileItem, RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { RemoteEditSessionRegistry } from '../services/RemoteEditSessionRegistry';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { pickRemoteDirectory } from './pickRemoteDirectory';
import { dropDescendantTargets } from './remoteTargets';

export interface MoveRemoteItemDependencies {
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  registry: RemoteEditSessionRegistry;
  output: vscode.OutputChannel;
  refresh: () => void;
  getCurrentPath: () => string | null;
}

// Moves files and folders shown in the Remote Files panel (feature 33d).
// A move is 33b's rename to a different parent — same transport call, same C2
// edit-session rewrite per moved entry — with the destination chosen through
// the pickRemoteDirectory QuickPick, starting where the panel currently is.
//
// Collisions: a single-target move follows the shared 33b rules (file target →
// Overwrite/Cancel with delete-then-rename, folder target → abort, never
// merge). A multi-target move NEVER prompts and NEVER overwrites — colliding
// items are skipped and named in the summary; re-run single-target to get the
// Overwrite prompt. Moves log no history (no bytes move) and never fire
// deploy hooks.
export async function moveRemoteItem(
  targets: RemoteFileItem[],
  dependencies: MoveRemoteItemDependencies
): Promise<void> {
  const { connection, configManager, registry, output, refresh, getCurrentPath } = dependencies;

  // A selected folder carries its selected descendants with it — moving both
  // would fail on the child (its path is gone) and overstate the summary.
  const dedupedTargets = dropDescendantTargets(targets);
  if (dedupedTargets.length === 0) {
    return;
  }
  const isMultiTarget = dedupedTargets.length > 1;

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

  const destination = await pickRemoteDirectory(
    connection,
    getCurrentPath() ?? connection.getRootPath(),
    isMultiTarget ? `Move ${dedupedTargets.length} items to` : `Move ${dedupedTargets[0].entry.name} to`
  );
  if (destination === undefined) {
    return; // cancelled
  }

  // Moving a folder into itself or its own subtree can never succeed — and on
  // some servers the attempt is destructive. Refuse outright, before anything
  // is touched. Symlinked folders count too: the destination would dangle.
  for (const target of dedupedTargets) {
    const { entry } = target;
    const isFolderLike = entry.type === 'd' || (entry.type === 'l' && entry.symlinkTarget === 'd');
    if (isFolderLike && (destination === entry.remotePath || destination.startsWith(entry.remotePath + '/'))) {
      vscode.window.showErrorMessage(
        `FileFerry: Cannot move "${entry.name}" into itself or its own subfolder.`
      );
      return;
    }
  }

  // A target already sitting in the chosen folder has nowhere to go — skip it.
  const alreadyThereNames = dedupedTargets
    .filter(target => path.posix.dirname(target.entry.remotePath) === destination)
    .map(target => target.entry.name);
  const movableEntries = dedupedTargets
    .filter(target => path.posix.dirname(target.entry.remotePath) !== destination)
    .map(target => target.entry);

  if (movableEntries.length === 0) {
    vscode.window.showInformationMessage(
      `FileFerry: ${alreadyThereNames.join(', ')} ${alreadyThereNames.length === 1 ? 'is' : 'are'} already in ${destination} — nothing to move.`
    );
    return;
  }

  if (config.dryRun) {
    for (const entry of movableEntries) {
      output.appendLine(
        `[remote-move] DRY RUN — would move ${entry.remotePath} → ${destinationPath(destination, entry.name)} (${serverName})`
      );
    }
    vscode.window.setStatusBarMessage(
      `$(beaker) Dry run — would move ${movableEntries.length === 1 ? movableEntries[0].name : `${movableEntries.length} items`}`,
      5000
    );
    return;
  }

  const serverId = connection.getCurrentServerId() ?? config.defaultServerId;

  if (!isMultiTarget) {
    await moveSingle(movableEntries[0], destination, serverName, serverId, dependencies);
    return;
  }

  const failures: { name: string; message: string }[] = [];
  const collidedNames: string[] = [];
  let movedCount = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Moving ${movableEntries.length} items...`,
    },
    async (progress) => {
      for (const entry of movableEntries) {
        progress.report({ message: entry.name });
        const newPath = destinationPath(destination, entry.name);
        try {
          // Never prompts, never overwrites in multi mode — skip and report.
          if (await connection.exists(newPath)) {
            collidedNames.push(entry.name);
            continue;
          }
          await connection.rename(entry.remotePath, newPath);
          registry.rewriteRemotePath(serverId, entry.remotePath, newPath);
          movedCount++;
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
      `FileFerry: Failed to move ${failures.length} of ${movableEntries.length} items — ${failureDescriptions.join('; ')}`
    );
  }

  let message = `FileFerry: Moved ${movedCount} item${movedCount === 1 ? '' : 's'} to ${destination}`;
  if (collidedNames.length > 0) {
    message += ` (skipped — already exist there: ${collidedNames.join(', ')})`;
  }
  if (alreadyThereNames.length > 0) {
    message += ` (already there: ${alreadyThereNames.join(', ')})`;
  }
  vscode.window.showInformationMessage(message);

  if (movedCount > 0) {
    refresh();
  }
}

async function moveSingle(
  entry: RemoteEntry,
  destination: string,
  serverName: string,
  serverId: string,
  dependencies: MoveRemoteItemDependencies
): Promise<void> {
  const { connection, registry, refresh } = dependencies;
  const newPath = destinationPath(destination, entry.name);

  // Once the colliding target is deleted, the server no longer matches the
  // panel — refresh even if the move itself then fails.
  let deletedCollidingTarget = false;
  try {
    const targetType = await connection.statRemoteType(newPath);
    if (targetType === 'd') {
      vscode.window.showErrorMessage(
        `FileFerry: A folder named "${entry.name}" already exists in ${destination} — folders are never overwritten or merged.`
      );
      return;
    }
    if (targetType !== null) {
      const choice = await vscode.window.showWarningMessage(
        `${entry.name} already exists in ${destination} on "${serverName}".`,
        {
          modal: true,
          detail: 'Overwriting will replace the remote file with the moved one.',
        },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        return;
      }
      await connection.deleteRemoteFile(newPath);
      deletedCollidingTarget = true;
    }

    await connection.rename(entry.remotePath, newPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to move ${entry.name} — ${message}`);
    if (deletedCollidingTarget) {
      refresh();
    }
    return;
  }

  // C2: rebind open edit sessions — exact match for a moved file, prefix match
  // inside rewriteRemotePath for sessions on files inside a moved folder.
  registry.rewriteRemotePath(serverId, entry.remotePath, newPath);

  vscode.window.setStatusBarMessage(`$(check) Moved ${entry.name} → ${destination}`, 3000);
  refresh();
}

// Remote paths are POSIX — joined with '/', never path.join.
function destinationPath(destination: string, name: string): string {
  return destination === '/' ? `/${name}` : `${destination}/${name}`;
}
