import * as vscode from 'vscode';
import * as fs from 'fs';
import { GitService } from '../gitService';
import { uploadSelected } from './uploadSelected';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

export async function uploadAllChanged(dependencies: Dependencies): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('FileFerry: No workspace folder open.');
    return;
  }

  const changed = new GitService().getChangedFiles(workspaceRoot);
  if (changed.length === 0) {
    vscode.window.showWarningMessage('FileFerry: No changed files found.');
    return;
  }

  let skippedDirectory = false;
  const fileEntries = changed.filter(file => {
    try {
      if (fs.statSync(file.absolutePath).isDirectory()) {
        skippedDirectory = true;
        return false;
      }
    } catch {
      // Path no longer exists (deleted file) — let ScmResourceResolver route it to toDelete
    }
    return true;
  });

  if (skippedDirectory) {
    vscode.window.showWarningMessage(
      'FileFerry: Skipped directory-level git entries (likely a submodule).'
    );
  }

  if (fileEntries.length === 0) {
    return;
  }

  const resources = fileEntries.map(file => ({
    resourceUri: vscode.Uri.file(file.absolutePath),
  })) as vscode.SourceControlResourceState[];

  await uploadSelected(resources[0], resources, dependencies);
}
