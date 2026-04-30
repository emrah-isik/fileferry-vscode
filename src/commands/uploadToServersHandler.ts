import * as vscode from 'vscode';
import { uploadToServers } from './uploadToServers';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { normalizeCommandArgs } from '../utils/normalizeCommandArgs';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

export function makeUploadToServersHandler(dependencies: Dependencies) {
  return (...args: unknown[]) => {
    const { resource, allResources } = normalizeCommandArgs(...args);
    return uploadToServers(resource, allResources, dependencies);
  };
}
