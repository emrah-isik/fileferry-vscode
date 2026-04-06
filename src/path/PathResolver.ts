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

export class PathResolver {
  resolve(localPath: string, workspaceRoot: string, serverConfig: ServerConfig): ResolvedUploadItem {
    const relativeLocal = path.relative(workspaceRoot, localPath);

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
    return localPaths.map(p => this.resolve(p, workspaceRoot, serverConfig));
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
