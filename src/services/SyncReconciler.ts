import { ResolvedUploadItem } from '../path/PathResolver';

/** A local file already resolved to its remote destination, with its mtime. */
export interface LocalFileEntry {
  localPath: string;
  remotePath: string; // resolved via PathResolver.resolve
  modifyTimeMs: number;
}

/** A remote file discovered by walking the mapped remote tree. */
export interface RemoteFileEntry {
  remotePath: string;
  modifyTimeMs: number; // from listDirectoryDetailed (FileEntry.modifyTime, ms)
}

export interface SyncPlan {
  toUpload: ResolvedUploadItem[]; // local-only + local strictly newer
  upToDate: ResolvedUploadItem[]; // both sides, same-age or remote-newer (skipped)
  remoteExtras: string[]; // remote paths with no eligible local counterpart
}

export interface ReconcileOptions {
  /** Remote-clock offset (ms); subtracted from remote mtimes before comparison. */
  timeOffsetMs?: number;
  /**
   * Returns true for remote paths that are deliberately unmanaged (excluded via
   * `excludedPaths` / `.fileferryignore`). Such paths are never treated as
   * extras, so delete-extras can never prune them — safety #6.
   */
  isRemotePathExcluded?: (remotePath: string) => boolean;
}

/**
 * Pure, I/O-free reconciliation of a fully-walked local tree against a
 * fully-walked remote tree for one-way local → remote sync.
 *
 * The mtime boundary mirrors {@link FileDateGuard.partitionByNewerLocal} (21b):
 * a file uploads only when it is missing remotely or **strictly newer** locally
 * (offset-adjusted); same-age and remote-newer files are held back (update-only
 * is always on in v1). Remote files with no eligible local counterpart are
 * reported as extras for the caller to optionally prune.
 */
export function reconcile(
  localFiles: LocalFileEntry[],
  remoteFiles: RemoteFileEntry[],
  options: ReconcileOptions = {}
): SyncPlan {
  const timeOffsetMs = options.timeOffsetMs ?? 0;
  const isRemotePathExcluded = options.isRemotePathExcluded ?? (() => false);

  const remoteByPath = new Map<string, RemoteFileEntry>();
  for (const remoteFile of remoteFiles) {
    remoteByPath.set(remoteFile.remotePath, remoteFile);
  }

  const localRemotePaths = new Set<string>();
  const toUpload: ResolvedUploadItem[] = [];
  const upToDate: ResolvedUploadItem[] = [];

  for (const localFile of localFiles) {
    localRemotePaths.add(localFile.remotePath);
    const item: ResolvedUploadItem = {
      localPath: localFile.localPath,
      remotePath: localFile.remotePath,
    };

    const remoteMatch = remoteByPath.get(localFile.remotePath);
    if (!remoteMatch) {
      toUpload.push(item); // local-only — new file
      continue;
    }

    const adjustedRemoteMtime = remoteMatch.modifyTimeMs - timeOffsetMs;
    if (localFile.modifyTimeMs > adjustedRemoteMtime) {
      toUpload.push(item); // strictly newer locally
    } else {
      upToDate.push(item); // same-age or remote-newer
    }
  }

  const remoteExtras: string[] = [];
  for (const remoteFile of remoteFiles) {
    if (localRemotePaths.has(remoteFile.remotePath)) {
      continue; // has a local counterpart
    }
    if (isRemotePathExcluded(remoteFile.remotePath)) {
      continue; // deliberately unmanaged — never an extra (safety #6)
    }
    remoteExtras.push(remoteFile.remotePath);
  }

  return { toUpload, upToDate, remoteExtras };
}
