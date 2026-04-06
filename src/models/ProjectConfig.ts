import { PathMapping } from './ProjectBinding';

export type ServerType = 'sftp' | 'ftp';

export interface ProjectServer {
  id: string;              // internal UUID — stable across renames
  type: ServerType;
  credentialId: string;    // UUID reference to SshCredential — primary lookup
  credentialName: string;  // human-readable fallback + documentation
  rootPath: string;
  mappings: PathMapping[];
  excludedPaths: string[];
}

// What's stored in .vscode/fileferry.json — server name is the object key
export interface ProjectConfig {
  defaultServerId: string;   // server UUID (ProjectServer.id)
  uploadOnSave?: boolean;
  fileDateGuard?: boolean;   // warn before overwriting newer remote files (default: true)
  backupBeforeOverwrite?: boolean;  // download remote files before uploading (default: false)
  backupRetentionDays?: number;     // days to keep backup folders (default: 7)
  backupMaxSizeMB?: number;         // max total backup size in MB (default: 100)
  servers: {
    [serverName: string]: ProjectServer;
  };
}
