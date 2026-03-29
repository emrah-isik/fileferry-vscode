import * as path from 'path';

export interface ResolvedUploadItem {
  localPath: string;
  remotePath: string;
}

interface ServerConfig {
  rootPath: string;
  rootPathOverride?: string;
  mappings: Array<{ localPath: string; remotePath: string }>;
  excludedPaths: string[];
}

export class PathResolver {
  resolve(localPath: string, workspaceRoot: string, serverConfig: ServerConfig): ResolvedUploadItem {
    const relativeLocal = path.relative(workspaceRoot, localPath);

    // Check excluded paths first
    for (const excluded of serverConfig.excludedPaths) {
      const excl = excluded.replace(/\/$/, '');
      if (relativeLocal === excl || relativeLocal.startsWith(excl + '/')) {
        throw new Error(`File is excluded: ${localPath}`);
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
}
