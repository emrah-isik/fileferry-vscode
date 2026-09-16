import * as crypto from 'crypto';

// Sidecar name for an atomic upload (write here, then rename over the target).
// The suffix is random per upload: two concurrent uploads of the same remote
// path, e.g. two configured servers that are the same host, or upload-on-save
// racing a watcher batch, must not share a temp file, or the second rename
// finds its file already renamed away and fails (#28). The ".fileferry" marker
// stays so leftovers are recognisable.
export function atomicUploadTempPath(remotePath: string): string {
  return `${remotePath}.fileferry-${crypto.randomBytes(4).toString('hex')}.tmp`;
}
