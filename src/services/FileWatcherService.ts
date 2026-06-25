import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { autoUploadFile } from './autoUpload';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  output: vscode.OutputChannel;
}

const DEBOUNCE_MS = 400;

/**
 * Auto-uploads files matching the user's `watch.patterns` globs whenever they
 * change on disk — including files written by build tools that never trigger an
 * editor save (the gap UploadOnSaveService can't cover). The declared globs are
 * an explicit allowlist, so watched files upload even when git-ignored
 * (`applyGitIgnore: false`); see autoUpload.ts.
 */
export class FileWatcherService {
  private watchers: vscode.Disposable[] = [];
  private configSubscription?: vscode.Disposable;
  private pending = new Set<string>();
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly dependencies: Dependencies) {}

  register(): vscode.Disposable {
    void this.rebuild();
    this.configSubscription = this.dependencies.configManager.onDidSaveConfig(() => {
      void this.rebuild();
    });
    return { dispose: () => this.dispose() };
  }

  private async rebuild(): Promise<void> {
    this.disposeWatchers();

    const config = await this.dependencies.configManager.getConfig();
    const watch = config?.watch;
    if (!watch?.enabled || !watch.patterns?.length) {
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }

    for (const pattern of watch.patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, pattern)
      );
      watcher.onDidCreate(uri => this.enqueue(uri));
      watcher.onDidChange(uri => this.enqueue(uri));
      // Deletes are intentionally not watched in v1 — see feature_25_plan.md.
      this.watchers.push(watcher);
    }
  }

  private enqueue(uri: vscode.Uri): void {
    if (this.isAlwaysExcluded(uri.fsPath)) {
      return;
    }
    this.pending.add(uri.fsPath);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  /** A path is uploadable only if it currently exists on disk as a regular file. */
  private isUploadableFile(fsPath: string): boolean {
    try {
      return !fs.statSync(fsPath).isDirectory();
    } catch {
      return false; // vanished (deleted/renamed) before the flush
    }
  }

  /** FileFerry's own writes must never re-trigger the watcher. */
  private isAlwaysExcluded(fsPath: string): boolean {
    return (
      fsPath.includes('.fileferry-backups') ||
      /[/\\]\.vscode[/\\]fileferry[^/\\]*\.json/i.test(fsPath)
    );
  }

  private async flush(): Promise<void> {
    this.debounceTimer = undefined;
    const raw = [...this.pending];
    this.pending.clear();
    // Drop directory events (e.g. `mkdir dist` fires for the dir itself) and
    // files that vanished between the event and the flush — only upload real files.
    const batch = raw.filter(fsPath => this.isUploadableFile(fsPath));
    if (batch.length === 0) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return;
    }

    const config = await this.dependencies.configManager.getConfig();
    if (!config?.watch?.enabled) {
      return;
    }

    if (config.dryRun) {
      for (const file of batch) {
        this.dependencies.output.appendLine(`FileFerry (watch, dry run): would upload ${file}`);
      }
      return;
    }

    const uploaded: string[] = [];
    const failed: string[] = [];

    for (const file of batch) {
      const outcome = await autoUploadFile(
        file,
        workspaceRoot,
        config,
        this.dependencies,
        'watch',
        { applyGitIgnore: false }
      );

      if (outcome.status === 'uploaded' && outcome.summary.failed.length === 0) {
        uploaded.push(file);
      } else if (outcome.status === 'skipped') {
        this.dependencies.output.appendLine(`FileFerry (watch): skipped ${file} (${outcome.reason})`);
      } else {
        const detail = outcome.status === 'error' ? outcome.error : 'upload failed';
        failed.push(`${file} (${detail})`);
      }
    }

    if (uploaded.length > 0) {
      this.dependencies.output.appendLine(
        `FileFerry (watch): uploaded ${uploaded.length} file(s): ${uploaded.map(f => path.basename(f)).join(', ')}`
      );
      vscode.window.setStatusBarMessage(`$(check) FileFerry watched ${uploaded.length} file(s)`, 3000);
    }
    if (failed.length > 0) {
      failed.forEach(entry => this.dependencies.output.appendLine(`FileFerry (watch): failed ${entry}`));
      vscode.window.showErrorMessage(
        `FileFerry: ${failed.length} watched file(s) failed to upload — see the FileFerry output.`
      );
    }
  }

  private disposeWatchers(): void {
    this.watchers.forEach(watcher => watcher.dispose());
    this.watchers = [];
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.disposeWatchers();
    this.configSubscription?.dispose();
  }
}
