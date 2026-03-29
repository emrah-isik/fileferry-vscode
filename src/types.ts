export type AuthMethod = 'password' | 'key' | 'agent';
export type ServerType = 'sftp' | 'ftp';
export type GitStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'copied';

export interface PathMapping {
  localPath: string;   // relative to workspace root e.g. "/" or "/public"
  remotePath: string;  // absolute on remote server e.g. "/var/www/html"
}

export interface ServerConfig {
  id: string;
  name: string;
  type: ServerType;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string; // only for authMethod: 'key'
  mappings: PathMapping[];
  excludedPaths: string[]; // glob patterns e.g. "node_modules", "*.log"
}

export interface FileFerryConfig {
  defaultServer?: string;
  servers: ServerConfig[];
}

export interface GitFile {
  absolutePath: string;
  relativePath: string;    // relative to workspaceRoot
  workspaceRoot: string;
  status: GitStatus;
  checked: boolean;        // checkbox state in the panel
}

export interface UploadPair {
  localPath: string;
  remotePath: string;
}

export interface UploadResult {
  succeeded: UploadPair[];
  failed: Array<{ pair: UploadPair; error: string }>;
}

export interface ConnectionResult {
  success: boolean;
  message: string;
}
