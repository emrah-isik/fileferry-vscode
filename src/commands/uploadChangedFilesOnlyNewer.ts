import * as vscode from 'vscode';
import { uploadChangedFilesSelection } from './uploadChangedFilesSelection';
import { uploadAllChanged } from './uploadAllChanged';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

/**
 * Adaptive only-newer action for the Changed Files panel title bar:
 * - if rows are selected → upload just those, skipping remotes of the same age or newer;
 * - if nothing is selected → upload every changed file, same skip rule.
 *
 * One button, two scopes — both run through the shared `onlyNewer` upload path.
 */
export async function uploadChangedFilesOnlyNewer(
  getSelection: () => readonly vscode.TreeItem[],
  dependencies: Dependencies
): Promise<void> {
  const hasSelection = getSelection().some(item => !!item.resourceUri);

  if (hasSelection) {
    await uploadChangedFilesSelection(getSelection, dependencies, { onlyNewer: true });
  } else {
    await uploadAllChanged(dependencies, { onlyNewer: true });
  }
}
