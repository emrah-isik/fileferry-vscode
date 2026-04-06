import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { PathResolver } from '../path/PathResolver';
import { UploadOrchestratorV2 } from './UploadOrchestratorV2';
import { CredentialManager } from '../storage/CredentialManager';
import { ServerManager } from '../storage/ServerManager';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';

interface Deps {
  credentialManager: CredentialManager;
  serverManager: ServerManager;
  bindingManager: ProjectBindingManager;
}

export class UploadOnSaveService {
  constructor(private readonly deps: Deps) {}

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

    const binding = await this.deps.bindingManager.getBinding();
    if (!binding?.uploadOnSave) {
      return;
    }

    const server = await this.deps.serverManager.getServer(binding.defaultServerId);
    if (!server) {
      return;
    }

    const serverBinding = binding.servers[server.id];
    if (!serverBinding) {
      return;
    }

    // Skip files ignored by git
    if (await this.isGitIgnored(doc.uri.fsPath, workspaceRoot)) {
      return;
    }

    const pathResolver = new PathResolver();
    const serverConfig = {
      rootPath: server.rootPath,
      rootPathOverride: serverBinding.rootPathOverride,
      mappings: serverBinding.mappings,
      excludedPaths: serverBinding.excludedPaths,
    };

    let resolved;
    try {
      resolved = pathResolver.resolve(doc.uri.fsPath, workspaceRoot, serverConfig);
    } catch {
      return;
    }

    const orchestrator = new UploadOrchestratorV2();
    try {
      const credential = await this.deps.credentialManager.getWithSecret(server.credentialId);
      const result = await orchestrator.upload([resolved], credential, server, []);

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
