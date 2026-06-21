import * as vscode from 'vscode';
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
 * Upload-only-newer (feature 21b): one-shot smart sync over the git-changed set.
 * Reuses the full upload pipeline via {@link uploadAllChanged}, but with the
 * only-newer filter on, so files the remote already holds at the same age or
 * newer are skipped instead of uploaded.
 */
export async function uploadOnlyNewer(dependencies: Dependencies): Promise<void> {
  await uploadAllChanged(dependencies, { onlyNewer: true });
}
