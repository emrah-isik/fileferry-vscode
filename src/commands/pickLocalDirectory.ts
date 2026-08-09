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
  title: string,
  // The confirm-row wording is context-sensitive: "Select this folder" reads
  // as the goal when picking a folder, but misleads when the folder is only
  // step 1 of picking FILES — the files flow overrides it.
  confirmRowLabel: string = '$(check) Select this folder'
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
      { label: confirmRowLabel, description: currentPath },
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

// Two-step multi-FILE pick for remote windows (feature-33 manual pass,
// finding U1): the simple file dialog those windows get ignores
// canSelectMany, so real multi-select needs a QuickPick — which cannot mix
// navigation with checkboxes. Step 1 navigates to a folder with
// pickLocalDirectory; step 2 multi-selects from a checkbox list of that
// folder's files. Returns absolute paths, or undefined on cancel/no files.
export async function pickLocalFiles(
  startPath: string,
  title: string
): Promise<string[] | undefined> {
  const directory = await pickLocalDirectory(
    startPath,
    `${title} — step 1 of 2`,
    '$(check) Choose files from this folder'
  );
  if (directory === undefined) {
    return undefined;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Could not list ${directory} — ${message}`);
    return undefined;
  }

  const fileNames = entries
    .filter(entry => {
      if (entry.isFile()) {
        return true;
      }
      if (entry.isSymbolicLink()) {
        // statSync follows the link; a broken link throws and is hidden.
        try {
          return fs.statSync(path.join(directory, entry.name)).isFile();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map(entry => entry.name)
    .sort();

  if (fileNames.length === 0) {
    vscode.window.showInformationMessage(`FileFerry: ${directory} contains no files to upload.`);
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    fileNames.map(name => ({ label: name })),
    {
      title: `${title} — step 2 of 2: ${directory}`,
      placeHolder: 'Select the files to upload (Space toggles, Enter confirms)',
      canPickMany: true,
    }
  );
  if (!picked || picked.length === 0) {
    return undefined;
  }
  return picked.map(item => path.join(directory, item.label));
}
