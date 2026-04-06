export interface PathMapping {
  localPath: string;   // relative to workspace root e.g. "/" or "/public"
  remotePath: string;  // absolute on remote server e.g. "/var/www/html"
}

export interface ServerBinding {
  mappings: PathMapping[];
  excludedPaths: string[]; // glob patterns e.g. "node_modules", "*.log"
  rootPathOverride?: string; // overrides DeploymentServer.rootPath for this project only
}

// ProjectBinding is stored in .vscode/fileferry.json — safe to commit (no secrets)
export interface ProjectBinding {
  defaultServerId: string;
  uploadOnSave?: boolean;
  servers: {
    [serverId: string]: ServerBinding;
  };
}
