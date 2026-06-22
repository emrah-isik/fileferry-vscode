import * as vscode from 'vscode';
import { uploadSelected } from './uploadSelected';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

export async function uploadChangedFilesSelection(
  getSelection: () => readonly vscode.TreeItem[],
  dependencies: Dependencies,
  options?: { onlyNewer?: boolean }
): Promise<void> {
  const resources = getSelection()
    .filter(item => !!item.resourceUri)
    .map(item => ({ resourceUri: item.resourceUri! } as vscode.SourceControlResourceState));

  if (resources.length === 0) {
    vscode.window.showWarningMessage('FileFerry: No files selected in Changed Files view.');
    return;
  }

  if (options) {
    await uploadSelected(resources[0], resources, dependencies, options);
  } else {
    await uploadSelected(resources[0], resources, dependencies);
  }
}
