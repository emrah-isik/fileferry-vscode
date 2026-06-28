import * as vscode from 'vscode';
import { syncFolderToRemote } from './syncToRemote';
import { normalizeCommandArgs } from '../utils/normalizeCommandArgs';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

export function makeSyncFolderToRemoteHandler(dependencies: Dependencies) {
  return (...args: unknown[]) => {
    // Explorer context menu passes (Uri, Uri[]); normalize to the selected folder paths.
    const { allResources } = normalizeCommandArgs(...args);
    const folderPaths = (allResources ?? []).map(resource => resource.resourceUri.fsPath);
    return syncFolderToRemote(folderPaths, dependencies);
  };
}
