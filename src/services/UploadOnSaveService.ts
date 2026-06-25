import * as vscode from 'vscode';
import * as path from 'path';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { autoUploadFile } from './autoUpload';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
}

export class UploadOnSaveService {
  constructor(private readonly dependencies: Dependencies) {}

  register(): vscode.Disposable {
    return vscode.workspace.onDidSaveTextDocument(doc =>
      this.handleSave(doc)
    );
  }

  private async handleSave(doc: vscode.TextDocument): Promise<void> {
    // Avoid recursive triggers from config file saves
    if (doc.fileName.endsWith('fileferry.json')) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return;
    }

    // File must be inside the workspace
    const relative = path.relative(workspaceRoot, doc.uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return;
    }

    const config = await this.dependencies.configManager.getConfig();
    if (!config?.uploadOnSave) {
      return;
    }

    if (config.dryRun) {
      return;  // silent — no log, no notification
    }

    const outcome = await autoUploadFile(
      doc.uri.fsPath,
      workspaceRoot,
      config,
      this.dependencies,
      'save',
      { applyGitIgnore: true }
    );

    if (outcome.status === 'skipped') {
      if (outcome.reason === 'remote-newer') {
        vscode.window.showWarningMessage(
          `FileFerry: ${outcome.fileName} is newer on the remote — upload skipped. Use Alt+U to overwrite.`
        );
      }
      return;
    }

    if (outcome.status === 'error') {
      vscode.window.showErrorMessage(`FileFerry: Upload on save failed — ${outcome.error}`);
      return;
    }

    if (outcome.summary.failed.length > 0) {
      vscode.window.showErrorMessage(
        `FileFerry: Upload on save failed — ${outcome.summary.failed[0].error}`
      );
    } else {
      vscode.window.setStatusBarMessage(`$(check) Uploaded ${outcome.fileName}`, 3000);
    }
  }
}
