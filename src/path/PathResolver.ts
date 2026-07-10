import * as path from 'path';
import { minimatch } from 'minimatch';

export interface ResolvedUploadItem {
  localPath: string;
  remotePath: string;
}

interface ServerConfig {
  rootPath: string;
  rootPathOverride?: string;
  mappings: Array<{ localPath: string; remotePath: string }>;
  excludedPaths: string[];
  ignoreExclusions?: boolean;
}

// FileFerry's own workspace artifacts, relative to the workspace root. These are
// NEVER deployed — publishing your deployment config/history to the server leaks
// it (server list, paths, credential names), fileferry-history.jsonl changes on
// every deploy (an endless dirty file), and on FTP the missing remote .vscode dir
// 553s. Excluded unconditionally — not even a force-upload (ignoreExclusions) can
// deploy them. `fileferry-backups` is a directory prefix.
const FILEFERRY_ARTIFACTS: readonly string[] = [
  '.vscode/fileferry.json',
  '.vscode/fileferry-history.jsonl',
  '.vscode/fileferry-backups',
];

function isFileFerryArtifact(relativeLocal: string): boolean {
  const normalized = relativeLocal.split(path.sep).join('/');
  return FILEFERRY_ARTIFACTS.some(
    artifact => normalized === artifact || normalized.startsWith(artifact + '/')
  );
}

export class PathResolver {
  resolve(localPath: string, workspaceRoot: string, serverConfig: ServerConfig): ResolvedUploadItem {
    const relativeToWorkspace = path.relative(workspaceRoot, localPath);

    // A file outside the workspace would build a remote path that escapes the
    // server's rootPath (e.g. `/var/www/../etc/passwd`). Checked first, and
    // independent of `ignoreExclusions` — force-upload must never override it.
    // Two shapes of escape: a `../` prefix, and (on Windows, across drives) an
    // absolute path, because path.relative can't express that as `../`.
    if (
      path.isAbsolute(relativeToWorkspace) ||
      relativeToWorkspace === '..' ||
      relativeToWorkspace.startsWith('..' + path.sep)
    ) {
      throw new Error(`File is outside the workspace: ${localPath}`);
    }

    // Normalise to '/' so the mapping match, the exclusion matcher, and the
    // remote-path builder below all see the separator they assume. Key off
    // path.sep rather than rewriting every backslash: on POSIX a backslash is
    // a legal filename character, and `weird\name.txt` must not turn into a
    // `weird/` directory on the server.
    const relativeLocal = relativeToWorkspace.split(path.sep).join('/');

    // FileFerry's own files are never deployable — checked before (and
    // independent of) user exclusions and ignoreExclusions.
    if (isFileFerryArtifact(relativeLocal)) {
      throw new Error(`File is excluded: ${localPath}`);
    }

    // Check excluded paths using glob matching (gitignore-style patterns)
    if (serverConfig.ignoreExclusions) {
      // Skip exclusion checks — used for force-upload of excluded files
    } else for (const pattern of serverConfig.excludedPaths) {
      // Match the full relative path against the pattern
      if (minimatch(relativeLocal, pattern, { matchBase: true, dot: true })) {
        throw new Error(`File is excluded: ${localPath}`);
      }
      // For bare names without glob chars (e.g. "node_modules", "dist"),
      // also treat them as directory prefixes (gitignore-style)
      if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('{')) {
        const excl = pattern.replace(/\/$/, '');
        if (relativeLocal === excl || relativeLocal.startsWith(excl + '/')) {
          throw new Error(`File is excluded: ${localPath}`);
        }
      }
    }

    // Find longest matching mapping (most specific wins).
    // If no mappings are configured, fall back to a catch-all root mapping.
    const effectiveMappings = serverConfig.mappings.length > 0
      ? serverConfig.mappings
      : [{ localPath: '/', remotePath: '' }];
    const sortedMappings = [...effectiveMappings].sort(
      (a, b) => b.localPath.length - a.localPath.length
    );

    for (const mapping of sortedMappings) {
      // Strip leading slash for comparison: '/' → '', '/public' → 'public'
      const mappingLocal = mapping.localPath.replace(/^\//, '');
      const matches =
        mappingLocal === '' ||
        relativeLocal === mappingLocal ||
        relativeLocal.startsWith(mappingLocal + '/');

      if (matches) {
        const relativeToMapping =
          mappingLocal === ''
            ? relativeLocal
            : relativeLocal.slice(mappingLocal.length + 1);

        const rootPath = (serverConfig.rootPathOverride?.trim() || serverConfig.rootPath).replace(/\/$/, '');
        const mappingRemote = mapping.remotePath.replace(/\/$/, '');

        const remotePath = [rootPath, mappingRemote, relativeToMapping]
          .filter(Boolean)
          .join('/');

        return { localPath, remotePath };
      }
    }

    throw new Error(
      `No mapping found for: ${localPath}. Configure a mapping in FileFerry Settings.`
    );
  }

  resolveAll(
    localPaths: string[],
    workspaceRoot: string,
    serverConfig: ServerConfig
  ): ResolvedUploadItem[] {
    // Silently drop FileFerry's own artifacts so a batch deploy that happens to
    // include them doesn't surface an "Upload Anyway?" prompt — they're never
    // deployable. User-excluded files still throw (per-file), preserving that flow.
    return localPaths
      .filter(p => !isFileFerryArtifact(path.relative(workspaceRoot, p)))
      .map(p => this.resolve(p, workspaceRoot, serverConfig));
  }

  /**
   * Reverse path resolution: remote → local.
   * Returns the absolute local workspace path, or null if no mapping matches.
   */
  resolveLocalPath(remotePath: string, workspaceRoot: string, serverConfig: ServerConfig): string | null {
    const rootPath = (serverConfig.rootPathOverride?.trim() || serverConfig.rootPath).replace(/\/$/, '');

    // Remote path must be under the root
    if (!remotePath.startsWith(rootPath + '/') && remotePath !== rootPath) {
      return null;
    }

    // Strip rootPath to get the portion that mappings operate on
    const afterRoot = remotePath === rootPath ? '' : remotePath.slice(rootPath.length + 1);

    const effectiveMappings = serverConfig.mappings.length > 0
      ? serverConfig.mappings
      : [{ localPath: '/', remotePath: '' }];

    // Sort by remotePath length descending (most specific wins)
    const sorted = [...effectiveMappings].sort(
      (a, b) => b.remotePath.length - a.remotePath.length
    );

    for (const mapping of sorted) {
      const mappingRemote = mapping.remotePath.replace(/\/$/, '');
      const matches =
        mappingRemote === '' ||
        afterRoot === mappingRemote ||
        afterRoot.startsWith(mappingRemote + '/');

      if (matches) {
        const relativeToMapping =
          mappingRemote === ''
            ? afterRoot
            : afterRoot.slice(mappingRemote.length + 1);

        const mappingLocal = mapping.localPath === '/' ? '' : mapping.localPath.replace(/^\//, '');
        const localRelative = [mappingLocal, relativeToMapping].filter(Boolean).join('/');
        return path.join(workspaceRoot, localRelative);
      }
    }

    return null;
  }
}
