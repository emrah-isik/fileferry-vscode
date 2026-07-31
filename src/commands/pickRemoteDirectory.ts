import * as vscode from 'vscode';
import * as path from 'path';
import { FileEntry } from '../transferService';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';

// Interactive remote-directory picker over the panel's own connection
// (feature 33d L2): a QuickPick loop of "Select this folder" / ".." /
// subdirectory rows, re-listing on every step, symlinks-to-directories
// navigable like real ones. Returns the chosen absolute POSIX path, or
// undefined when the user dismisses the picker. Adapted from
// DeploymentSettingsPanel.handleBrowseDirectory, which stays webview-scoped —
// this one is reusable by any panel command that needs a destination.
// A "Type a path…" row is a deferred nicety (see the feature 33 plan).
export async function pickRemoteDirectory(
  connection: RemoteBrowserConnection,
  startPath: string,
  title: string
): Promise<string | undefined> {
  let currentPath = startPath || '/';
  if (currentPath !== '/' && currentPath.endsWith('/')) {
    currentPath = currentPath.slice(0, -1);
  }

  while (true) {
    let entries: FileEntry[];
    try {
      entries = await connection.listDirectory(currentPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`FileFerry: Could not list ${currentPath} — ${message}`);
      return undefined;
    }

    const symlinkTargets = await connection.resolveSymlinkTargets(entries, currentPath);
    const directoryNames = [
      ...entries.filter(entry => entry.type === 'd').map(entry => entry.name),
      ...entries
        .filter(entry => entry.type === 'l' && symlinkTargets.get(entry.name) === 'd')
        .map(entry => entry.name),
    ].sort();

    const quickPickItems: vscode.QuickPickItem[] = [
      { label: '$(check) Select this folder', description: currentPath },
      ...(currentPath !== '/' ? [{ label: '$(arrow-up) ..', description: '(parent directory)' }] : []),
      ...directoryNames.map(name => ({ label: `$(folder) ${name}` })),
    ];

    const picked = await vscode.window.showQuickPick(quickPickItems, {
      title: `${title}: ${currentPath}`,
      placeHolder: 'Select a folder or navigate into a subdirectory',
    });

    if (!picked) {
      return undefined;
    }
    if (picked.label.startsWith('$(check)')) {
      return currentPath;
    }
    if (picked.label.startsWith('$(arrow-up)')) {
      currentPath = path.posix.dirname(currentPath);
    } else {
      const folderName = picked.label.replace('$(folder) ', '');
      currentPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
    }
  }
}
