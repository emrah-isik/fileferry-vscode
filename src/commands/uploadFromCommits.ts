import * as vscode from 'vscode';
import * as fs from 'fs';
import { GitService } from '../gitService';
import { uploadSelected } from './uploadSelected';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}

interface CommitLike {
  id?: string;
  hash?: string;
  commit?: string;
}

function extractSha(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') { return undefined; }
  const c = item as CommitLike;
  return c.id ?? c.hash ?? c.commit;
}

function collectShas(arg1: unknown, arg2: unknown): string[] {
  const candidates: unknown[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) {
      candidates.push(...v);
    } else if (v) {
      candidates.push(v);
    }
  };
  push(arg1);
  push(arg2);

  const shas: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const sha = extractSha(c);
    if (sha && !seen.has(sha)) {
      seen.add(sha);
      shas.push(sha);
    }
  }
  return shas;
}

const COMMIT_PICKER_LIMIT = 50;

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) { return `${seconds}s ago`; }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes}m ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.floor(hours / 24);
  if (days < 30) { return `${days}d ago`; }
  const months = Math.floor(days / 30);
  if (months < 12) { return `${months}mo ago`; }
  return `${Math.floor(months / 12)}y ago`;
}

async function pickCommitsFromQuickPick(
  workspaceRoot: string,
  git: GitService
): Promise<string[]> {
  const commits = await git.getRecentCommits(workspaceRoot, COMMIT_PICKER_LIMIT);
  if (commits.length === 0) {
    vscode.window.showWarningMessage('FileFerry: No commits found in this repository.');
    return [];
  }

  const items = commits.map(c => ({
    label: c.subject,
    description: c.sha.slice(0, 7),
    detail: `${c.author} — ${formatRelativeTime(c.timestamp)}`,
    sha: c.sha,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select commit(s) to upload — uploads working-tree contents of touched files',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked || picked.length === 0) {
    return [];
  }
  return picked.map(p => p.sha);
}

export async function uploadFromCommits(
  primary: unknown,
  selected: unknown,
  dependencies: Dependencies
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('FileFerry: No workspace folder open.');
    return;
  }

  const git = new GitService();

  let shas = collectShas(primary, selected);
  if (shas.length === 0) {
    shas = await pickCommitsFromQuickPick(workspaceRoot, git);
    if (shas.length === 0) {
      return;
    }
  }
  const seen = new Set<string>();
  const touched: { absolutePath: string }[] = [];

  for (const sha of shas) {
    const files = await git.getFilesChangedInCommit(workspaceRoot, sha);
    for (const f of files) {
      if (seen.has(f.absolutePath)) { continue; }
      seen.add(f.absolutePath);
      touched.push({ absolutePath: f.absolutePath });
    }
  }

  if (touched.length === 0) {
    vscode.window.showWarningMessage(
      'FileFerry: Selected commit(s) touched no files.'
    );
    return;
  }

  let skippedDirectory = false;
  const fileEntries = touched.filter(file => {
    try {
      if (fs.statSync(file.absolutePath).isDirectory()) {
        skippedDirectory = true;
        return false;
      }
    } catch {
      // Path no longer exists — let ScmResourceResolver route it to toDelete
    }
    return true;
  });

  if (skippedDirectory) {
    vscode.window.showWarningMessage(
      'FileFerry: Skipped directory-level git entries (likely a submodule).'
    );
  }

  if (fileEntries.length === 0) {
    return;
  }

  const resources = fileEntries.map(file => ({
    resourceUri: vscode.Uri.file(file.absolutePath),
  })) as vscode.SourceControlResourceState[];

  await uploadSelected(resources[0], resources, dependencies);
}
