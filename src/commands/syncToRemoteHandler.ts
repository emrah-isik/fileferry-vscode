import * as vscode from 'vscode';
import { syncToRemote } from './syncToRemote';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

export function makeSyncToRemoteHandler(dependencies: Dependencies) {
  return () => syncToRemote(dependencies);
}
