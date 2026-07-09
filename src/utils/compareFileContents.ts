// Classifies how a local file differs from its remote counterpart, so
// "Compare with Remote" (#27b follow-up) can tell the user "identical" or
// "line endings only" instead of opening an empty-looking diff.
//
// - 'identical': byte-for-byte equal.
// - 'eol-only':  equal once line endings (CRLF/CR → LF) and a trailing newline
//                are normalized — i.e. the only differences are line endings /
//                final newline, which a deploy WOULD still overwrite.
// - 'different': real content differences.
export type FileComparison = 'identical' | 'eol-only' | 'different';

function normalizeLineEndings(buffer: Buffer): string {
  return buffer
    .toString('utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');
}

export function compareFileContents(local: Buffer, remote: Buffer): FileComparison {
  if (local.equals(remote)) {
    return 'identical';
  }
  if (normalizeLineEndings(local) === normalizeLineEndings(remote)) {
    return 'eol-only';
  }
  return 'different';
}
