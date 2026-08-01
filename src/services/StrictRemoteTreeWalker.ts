import { FileEntry } from '../transferService';

// The minimal listing surface the walker needs — RemoteBrowserConnection
// satisfies it, and tests can pass a plain stub.
export interface RemoteTreeLister {
  listDirectory(remotePath: string): Promise<FileEntry[]>;
}

export interface RemoteTreeSnapshot {
  // Every regular file, discovery order (parent directories before children).
  files: { remotePath: string; size: number }[];
  // Every directory under the root (the root itself excluded), parent-first —
  // EMPTY directories included, so a copy can recreate the full skeleton.
  directories: string[];
  // Symlinks are never copied (existing policy) but are recorded so the
  // confirmation can count and name them.
  symlinks: string[];
  totalBytes: number;
}

// Strict recursive walk for copy operations (feature 33g, L2). Deliberately
// NOT SyncTreeWalker.walkRemoteTree: that walker swallows listing errors into
// an empty subtree — correct for sync ("remote root not created yet"), but a
// copy built on it would silently produce a partial duplicate that reports
// success. Here a listing failure THROWS and the caller aborts before any
// write. Directories are emitted too: empty ones must exist in the copy.
export async function walkRemoteTreeStrict(
  lister: RemoteTreeLister,
  rootPath: string
): Promise<RemoteTreeSnapshot> {
  const files: { remotePath: string; size: number }[] = [];
  const directories: string[] = [];
  const symlinks: string[] = [];
  let totalBytes = 0;

  async function descend(directory: string): Promise<void> {
    const entries = await lister.listDirectory(directory); // failures propagate — abort, never a partial tree
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') {
        continue;
      }
      const childPath = directory === '/' ? `/${entry.name}` : `${directory}/${entry.name}`;
      if (entry.type === 'd') {
        directories.push(childPath);
        await descend(childPath);
      } else if (entry.type === '-') {
        files.push({ remotePath: childPath, size: entry.size });
        totalBytes += entry.size;
      } else {
        symlinks.push(childPath);
      }
    }
  }

  await descend(rootPath);
  return { files, directories, symlinks, totalBytes };
}
