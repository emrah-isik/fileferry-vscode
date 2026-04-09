import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { PathResolver } from '../path/PathResolver';
import { UploadOrchestratorV2 } from './UploadOrchestratorV2';
import { FileDateGuard } from './FileDateGuard';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

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

    const match = await this.dependencies.configManager.getServerById(config.defaultServerId);
    if (!match) {
      return;
    }

    const { server } = match;

    if (server.mappings.length === 0) {
      return;
    }

    // Skip files ignored by git
    if (await this.isGitIgnored(doc.uri.fsPath, workspaceRoot)) {
      return;
    }

    const pathResolver = new PathResolver();
    const serverConfig = {
      rootPath: server.rootPath,
      mappings: server.mappings,
      excludedPaths: server.excludedPaths,
    };

    let resolved;
    try {
      resolved = pathResolver.resolve(doc.uri.fsPath, workspaceRoot, serverConfig);
    } catch {
      return;
    }

    const orchestrator = new UploadOrchestratorV2();
    try {
      const credential = await this.dependencies.credentialManager.getWithSecret(server.credentialId);

      // File date guard: skip upload if remote is newer (non-blocking on errors)
      const fileDateGuardEnabled = config.fileDateGuard !== false;
      try {
        const newerOnRemote = fileDateGuardEnabled
          ? await new FileDateGuard().check([resolved], credential, server.timeOffsetMs)
          : [];
        if (newerOnRemote.length > 0) {
          const fileName = path.basename(doc.uri.fsPath);
          vscode.window.showWarningMessage(
            `FileFerry: ${fileName} is newer on the remote — upload skipped. Use Alt+U to overwrite.`
          );
          return;
        }
      } catch {
        // Date guard failure should not block the upload
      }

      const result = await orchestrator.upload([resolved], credential, null, []);

      if (result.failed.length > 0) {
        vscode.window.showErrorMessage(
          `FileFerry: Upload on save failed — ${result.failed[0].error}`
        );
      } else {
        const fileName = path.basename(doc.uri.fsPath);
        vscode.window.setStatusBarMessage(`$(check) Uploaded ${fileName}`, 3000);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`FileFerry: Upload on save failed — ${message}`);
    }
  }

  private isGitIgnored(filePath: string, cwd: string): Promise<boolean> {
    return new Promise(resolve => {
      execFile('git', ['check-ignore', '-q', filePath], { cwd }, (err) => {
        if (!err) {
          resolve(true); // exit 0 = ignored
        } else if ((err as any).code === 1) {
          resolve(false); // exit 1 = not ignored
        } else {
          resolve(false); // git not available or other error — don't block
        }
      });
    });
  }
}
