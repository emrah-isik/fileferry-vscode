import * as fs from 'fs/promises';
import * as path from 'path';

// Ensures `entry` is present in the workspace's `.gitignore`, creating the file
// if it doesn't exist. Idempotent (skips when already listed) and **git-agnostic**
// — writing the entry needs no initialized repo; git honors `.gitignore` whenever
// the folder becomes a repo. Used to keep FileFerry's machine-local artifacts
// (history, backups, the local-hooks override) out of source control the moment
// they're first written. Bare entry, no comment (repo convention for ignore files).
export async function ensureGitignored(workspaceRoot: string, entry: string): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');

  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf-8');
  } catch {
    existing = ''; // no .gitignore yet — we'll create it
  }

  const alreadyListed = existing.split('\n').some(line => line.trim() === entry);
  if (alreadyListed) {
    return;
  }

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.appendFile(gitignorePath, `${separator}${entry}\n`, 'utf-8');
}
