import * as vscode from 'vscode';
import * as path from 'path';
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
  };
}

export class GitService {
  private api: { repositories: GitRepository[] } | null = null;

  constructor() {
    this.api = this.loadGitAPI();
  }

  private loadGitAPI(): { repositories: GitRepository[] } | null {
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

  getBranchName(workspaceRoot: string): string {
    const repo = this.api?.repositories.find(
      r => r.rootUri.fsPath === workspaceRoot
    );
    return repo?.state.HEAD?.name ?? 'unknown';
  }
}
