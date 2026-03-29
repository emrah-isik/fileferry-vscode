import * as vscode from 'vscode';
import * as fs from 'fs';

export interface ResolvedResources {
  toUpload: string[];
  toDelete: string[];
}

export class ScmResourceResolver {
  /**
   * Extracts absolute local file paths from the arguments VSCode passes
   * to a scm/resourceState/context command handler, split by whether the
   * file still exists on disk.
   *
   * VSCode passes:
   *   - primaryResource: the right-clicked item (SourceControlResourceState)
   *   - allResources: all currently selected items (SourceControlResourceState[])
   *
   * When triggered via keybinding with nothing selected, both may be undefined.
   * Files present on disk go into toUpload; files deleted from disk go into toDelete.
   */
  resolve(
    primaryResource?: vscode.SourceControlResourceState,
    allResources?: vscode.SourceControlResourceState[]
  ): ResolvedResources {
    const resources =
      allResources && allResources.length > 0
        ? allResources
        : primaryResource
        ? [primaryResource]
        : [];

    const paths = resources.map(r => r.resourceUri.fsPath);
    const unique = [...new Set(paths)];

    const toUpload: string[] = [];
    const toDelete: string[] = [];

    for (const p of unique) {
      if (fs.existsSync(p)) {
        toUpload.push(p);
      } else {
        toDelete.push(p);
      }
    }

    return { toUpload, toDelete };
  }
}
