import * as fs from 'fs';
import * as path from 'path';
import type { CancellationToken } from 'vscode';
import type { TransferService, FileEntry } from '../transferService';
import type { RemoteFileEntry } from './SyncReconciler';

/** Joins a remote (POSIX) directory and child name into a single path. */
function joinRemotePath(directory: string, name: string): string {
  return `${directory.replace(/\/$/, '')}/${name}`;
}

/**
 * Recursively walks the remote tree under `remoteRoot` via
 * {@link TransferService.listDirectoryDetailed}, returning a flat list of every
 * regular file with its modify time. Directories are descended into; symlinks
 * are deliberately skipped so they can never be reported as deletable extras in
 * v1 (safety). A missing root (the listing rejects) yields an empty tree — the
 * "remote root not created yet" case, where every local file is simply new.
 *
 * The transfer service must already be connected. Cancellation halts the walk.
 */
export async function walkRemoteTree(
  transfer: TransferService,
  remoteRoot: string,
  token?: CancellationToken,
  ignoredDirectoryNames: ReadonlySet<string> = new Set()
): Promise<RemoteFileEntry[]> {
  const files: RemoteFileEntry[] = [];

  async function descend(directory: string): Promise<void> {
    if (token?.isCancellationRequested) {
      return;
    }

    let entries: FileEntry[];
    try {
      entries = await transfer.listDirectoryDetailed(directory);
    } catch {
      return; // directory absent (e.g. remote root not created yet)
    }

    for (const entry of entries) {
      if (token?.isCancellationRequested) {
        return;
      }
      if (entry.name === '.' || entry.name === '..') {
        continue;
      }
      const childPath = joinRemotePath(directory, entry.name);
      if (entry.type === 'd') {
        if (ignoredDirectoryNames.has(entry.name)) {
          continue; // e.g. .git / node_modules — never walked, never an extra
        }
        await descend(childPath);
      } else if (entry.type === '-') {
        files.push({ remotePath: childPath, modifyTimeMs: entry.modifyTime });
      }
      // entry.type === 'l' (symlink): not collected — never a deletable extra (v1)
    }
  }

  await descend(remoteRoot);
  return files;
}

/**
 * Recursively walks the local filesystem under `rootDirectory`, returning the
 * absolute path of every regular file. Symlinks are skipped (conservative v1
 * behaviour). A non-existent root yields an empty list. Exclusion and remote
 * mapping are applied by the caller via {@link PathResolver}; this walk only
 * discovers candidate files.
 */
export function walkLocalTree(
  rootDirectory: string,
  ignoredDirectoryNames: ReadonlySet<string> = new Set()
): string[] {
  const files: string[] = [];

  if (!fs.existsSync(rootDirectory)) {
    return files;
  }

  function descend(directory: string): void {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectoryNames.has(entry.name)) {
          continue; // e.g. .git / node_modules — never walked
        }
        descend(childPath);
      } else if (entry.isFile()) {
        files.push(childPath);
      }
      // symlinks skipped in v1
    }
  }

  descend(rootDirectory);
  return files;
}
