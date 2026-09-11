/**
 * vscode-sftp's `context` is a workspace-relative folder written any which
 * way (`./src/`, `src`, `src\\app`). Normalise it to a bare relative path
 * with forward slashes and no leading `./` or trailing `/`; the workspace
 * root itself becomes ''.
 */
export function normaliseContext(context: string | undefined): string {
  if (!context) { return ''; }
  let value = context.replace(/\\/g, '/').trim();
  while (value.startsWith('./')) { value = value.slice(2); }
  value = value.replace(/^\/+/, '').replace(/\/+$/, '');
  return value === '.' ? '' : value;
}
