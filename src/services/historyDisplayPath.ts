import type { UploadHistoryEntry } from '../models/UploadHistoryEntry';

// Rows written by the Remote Files panel (edit in place, create, duplicate)
// record a temporary local copy as their localPath, e.g.
// /tmp/fileferry-browse/web.remote.601cdd9c.php. That name means nothing to
// the user, so these rows show the remote path instead (#31). Remote Upload is
// not in the set: its localPath is the real file on disk that was uploaded.
const REMOTE_PANEL_TRIGGERS: ReadonlySet<UploadHistoryEntry['trigger']> = new Set([
  'remote-edit',
  'remote-create',
  'remote-duplicate',
]);

export function historyDisplayPath(entry: UploadHistoryEntry): string {
  if (REMOTE_PANEL_TRIGGERS.has(entry.trigger)) {
    return entry.remotePath;
  }
  return entry.localPath || entry.remotePath;
}
