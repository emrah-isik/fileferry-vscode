import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { GitFile, GitStatus } from './types';

// VSCode ships a built-in git extension. We access it via its public API.
// The numeric status codes map to the Status enum in the git extension's API.
// https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
const STATUS_MAP: Record<number, GitStatus> = {
  0: 'untracked',  // UNTRACKED (from untrackedChanges, but also used as fallback)
  1: 'added',      // INDEX_ADDED
  2: 'modified',   // INDEX_MODIFIED
  3: 'deleted',    // INDEX_DELETED
  4: 'renamed',    // INDEX_RENAMED
  5: 'modified',   // MODIFIED
  6: 'deleted',    // DELETED
  7: 'untracked',  // UNTRACKED
  8: 'added',      // INTENT_TO_ADD
  20: 'copied',    // INDEX_COPIED
};

// The shape of a repository from the VSCode git API (simplified)
export interface GitRepository {
  rootUri: { fsPath: string };
  state: {
    HEAD: { name: string; commit: string } | null;
    workingTreeChanges: Array<{ uri: { fsPath: string }; status: number }>;
    indexChanges: Array<{ uri: { fsPath: string }; status: number }>;
    untrackedChanges: Array<{ uri: { fsPath: string } }>;
    onDidChange?: (listener: () => void) => { dispose: () => void };
  };
}

interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository?: (listener: (repo: GitRepository) => void) => { dispose: () => void };
}

export class GitService {
  private api: GitAPI | null = null;

  constructor() {
    this.api = this.loadGitAPI();
  }

  private loadGitAPI(): GitAPI | null {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) {
      return null;
    }
    return ext.exports.getAPI(1);
  }

  getRepositories(): GitRepository[] {
    return this.api?.repositories ?? [];
  }

  // Returns all changed files (working tree + index + untracked) for a given workspace root.
  getChangedFiles(workspaceRoot: string): GitFile[] {
    const repo = this.api?.repositories.find(
      r => r.rootUri.fsPath === workspaceRoot
    );
    if (!repo) {
      return [];
    }

    const files: GitFile[] = [];
    const seen = new Set<string>();

    const addFile = (fsPath: string, status: GitStatus) => {
      if (seen.has(fsPath)) { return; }
      seen.add(fsPath);
      const relativePath = path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
      files.push({
        absolutePath: fsPath,
        relativePath,
        workspaceRoot,
        status,
        checked: false
      });
    };

    for (const change of repo.state.workingTreeChanges) {
      addFile(change.uri.fsPath, STATUS_MAP[change.status] ?? 'modified');
    }

    for (const change of repo.state.indexChanges) {
      addFile(change.uri.fsPath, STATUS_MAP[change.status] ?? 'added');
    }

    for (const change of repo.state.untrackedChanges) {
      addFile(change.uri.fsPath, 'untracked');
    }

    return files;
  }

  // Subscribes a callback to fire whenever any repository's state changes
  // (staged, working tree, untracked, branch, etc.). Used by views that want
  // to mirror git state — e.g. the Changed Files view.
  //
  // Also fires when a repository is opened after activation: the git extension
  // scans the filesystem asynchronously, so repos can appear seconds after our
  // extension has activated. Without this, the view stays empty until the user
  // hits Refresh manually.
  onRepositoryChange(callback: () => void): { dispose: () => void } {
    const subs: Array<{ dispose: () => void }> = [];

    for (const repo of this.api?.repositories ?? []) {
      const sub = repo.state.onDidChange?.(callback);
      if (sub) { subs.push(sub); }
    }

    const openSub = this.api?.onDidOpenRepository?.((repo) => {
      callback();
      const sub = repo.state.onDidChange?.(callback);
      if (sub) { subs.push(sub); }
    });
    if (openSub) { subs.push(openSub); }

    return {
      dispose: () => subs.forEach(s => s.dispose()),
    };
  }

  getBranchName(workspaceRoot: string): string {
    const repo = this.api?.repositories.find(
      r => r.rootUri.fsPath === workspaceRoot
    );
    return repo?.state.HEAD?.name ?? 'unknown';
  }

  // Returns up to `limit` recent commits from HEAD. Used by the QuickPick
  // entry point for "Upload Files from Commit". ASCII unit/record separators
  // are used to avoid collisions with characters that legitimately appear in
  // commit subjects (pipes, colons, tabs, etc.).
  async getRecentCommits(
    workspaceRoot: string,
    limit: number
  ): Promise<Array<{ sha: string; subject: string; author: string; timestamp: number }>> {
    const FS = String.fromCharCode(0x1f);
    const RS = String.fromCharCode(0x1e);
    const format = `--pretty=format:%H${FS}%s${FS}%an${FS}%at${RS}`;
    const result = await this.runGit(workspaceRoot, ['log', '-n', String(limit), format]);
    if (result.error) { return []; }

    const commits: Array<{ sha: string; subject: string; author: string; timestamp: number }> = [];
    for (const record of result.stdout.split(RS)) {
      const trimmed = record.replace(/^\n+/, '');
      if (!trimmed) { continue; }
      const fields = trimmed.split(FS);
      if (fields.length < 4) { continue; }
      commits.push({
        sha: fields[0],
        subject: fields[1],
        author: fields[2],
        timestamp: parseInt(fields[3], 10),
      });
    }
    return commits;
  }

  // Returns the files touched by the given commit. Status reflects the change
  // recorded by the commit; absolute path points to the working-tree location
  // (post-rename for renames, destination for copies).
  //
  // Merge commits return an empty list (default `git diff-tree` behavior).
  // Root commits fall back to `git show --name-status`.
  async getFilesChangedInCommit(workspaceRoot: string, sha: string): Promise<GitFile[]> {
    const hasParent = await this.commitHasParent(workspaceRoot, sha);

    const result = hasParent
      ? await this.runGit(workspaceRoot, ['diff-tree', '--no-commit-id', '--name-status', '-r', sha])
      : await this.runGit(workspaceRoot, ['show', '--name-status', '--pretty=format:', sha]);

    if (result.error) {
      return [];
    }
    return this.parseNameStatus(result.stdout, workspaceRoot);
  }

  private commitHasParent(workspaceRoot: string, sha: string): Promise<boolean> {
    return this.runGit(workspaceRoot, ['rev-parse', '--verify', `${sha}^`])
      .then(r => !r.error);
  }

  private runGit(
    cwd: string,
    args: string[]
  ): Promise<{ error: Error | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      execFile('git', args, { cwd }, (error, stdout, stderr) => {
        resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });
  }

  private parseNameStatus(output: string, workspaceRoot: string): GitFile[] {
    const files: GitFile[] = [];
    const seen = new Set<string>();

    for (const rawLine of output.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) { continue; }

      const parts = line.split('\t');
      if (parts.length < 2) { continue; }

      const statusLetter = parts[0][0];
      const targetPath = parts[parts.length - 1];

      let status: GitStatus;
      switch (statusLetter) {
        case 'A': status = 'added'; break;
        case 'M': status = 'modified'; break;
        case 'D': status = 'deleted'; break;
        case 'R': status = 'renamed'; break;
        case 'C': status = 'copied'; break;
        default: status = 'modified';
      }

      const absolutePath = path.resolve(workspaceRoot, targetPath);
      if (seen.has(absolutePath)) { continue; }
      seen.add(absolutePath);

      files.push({
        absolutePath,
        relativePath: targetPath.replace(/\\/g, '/'),
        workspaceRoot,
        status,
        checked: false,
      });
    }

    return files;
  }
}
