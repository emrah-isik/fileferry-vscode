// One entry per remote file currently open for editing via the Remote Files
// panel (feature 32a). A session binds a temp file on disk to the server the
// bytes were downloaded from, so a later save can upload back to the right
// place and detect that the remote moved underneath the edit.
export interface RemoteEditSession {
  serverId: string;          // server the bytes were downloaded from (bound at open time)
  remotePath: string;
  downloadedMtimeMs: number; // raw remote mtime at download — conflict baseline
  sha256: string;            // hash of the downloaded bytes — confirms a suspected conflict
}

// Sessions are bound to server IDENTITY, not connection state: they must
// survive idle disconnects (ensureConnected reconnects on save) and
// default-server swaps (the mismatch is what triggers the server-switch
// prompt). There is deliberately NO bulk eviction — a save on an evicted
// session would be silently ignored, which is this feature's worst failure
// mode. The registry is bounded by unregister() on onDidCloseTextDocument.
export class RemoteEditSessionRegistry {
  private readonly sessions = new Map<string, RemoteEditSession>();

  register(tempPath: string, session: RemoteEditSession): void {
    this.sessions.set(tempPath, session);
  }

  get(tempPath: string): RemoteEditSession | undefined {
    return this.sessions.get(tempPath);
  }

  unregister(tempPath: string): void {
    this.sessions.delete(tempPath);
  }

  // Follows a remote rename/move (feature 33, ruling C2): sessions pointing at
  // the renamed entry are rebound to its new path, so the next save uploads to
  // where the file now lives instead of recreating it under the old name.
  // Exact match covers a renamed file; the prefix match covers sessions on
  // files INSIDE a renamed directory. Scoped to one server — the same path on
  // another server is a different file. No match is a no-op.
  rewriteRemotePath(serverId: string, oldPath: string, newPath: string): void {
    const oldPrefix = oldPath + '/';
    for (const session of this.sessions.values()) {
      if (session.serverId !== serverId) {
        continue;
      }
      if (session.remotePath === oldPath) {
        session.remotePath = newPath;
      } else if (session.remotePath.startsWith(oldPrefix)) {
        session.remotePath = newPath + session.remotePath.slice(oldPath.length);
      }
    }
  }
}
