import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Local twin of pickRemoteDirectory (33f follow-up): a QuickPick loop with an
// explicit "$(check) Select this folder" row over the LOCAL filesystem.
// Exists for remote windows (WSL/SSH), where showOpenDialog falls back to VS
// Code's simple file dialog — whose only folder-confirm is the easy-to-miss
// OK button next to the input, with no select-this-folder row in the list.
// Desktop windows keep the native OS dialog; this picker is not used there.
export async function pickLocalDirectory(
  startPath: string,
  title: string
): Promise<string | undefined> {
  let currentPath = startPath;

  while (true) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`FileFerry: Could not list ${currentPath} — ${message}`);
      return undefined;
    }

    const directoryNames = entries
      .filter(entry => {
        if (entry.isDirectory()) {
          return true;
        }
        if (entry.isSymbolicLink()) {
          // statSync follows the link; a broken link throws and is hidden.
          try {
            return fs.statSync(path.join(currentPath, entry.name)).isDirectory();
          } catch {
            return false;
          }
        }
        return false;
      })
      .map(entry => entry.name)
      .sort();

    // path.dirname is a fixed point at the filesystem root ('/' or 'C:\').
    const isRoot = path.dirname(currentPath) === currentPath;
    const quickPickItems: vscode.QuickPickItem[] = [
      { label: '$(check) Select this folder', description: currentPath },
      ...(!isRoot ? [{ label: '$(arrow-up) ..', description: '(parent directory)' }] : []),
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
      currentPath = path.dirname(currentPath);
    } else {
      currentPath = path.join(currentPath, picked.label.replace('$(folder) ', ''));
    }
  }
}
