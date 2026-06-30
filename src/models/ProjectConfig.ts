import { PathMapping } from './ProjectBinding';

export type ServerType = 'sftp' | 'ftp' | 'ftps' | 'ftps-implicit';

// Where a deploy hook runs: 'local' on the user's machine via the shell,
// 'remote' on the server over the deploy's own SSH connection (SFTP only).
export type HookLocation = 'local' | 'remote';

// A single pre/post-deploy command. Lives in fileferry.json (committed) or the
// git-ignored fileferry.local.json. The model owns this shape; HookRunner
// (the executor) imports it from here.
export interface HookCommand {
  command: string;
  location: HookLocation;
  continueOnError?: boolean;  // a failure is logged but doesn't abort the deploy
  timeoutMs?: number;         // per-hook timeout so a hung command can't wedge the deploy
}

export interface ProjectServer {
  id: string;              // internal UUID — stable across renames
  type: ServerType;
  credentialId: string;    // UUID reference to SshCredential — primary lookup
  credentialName: string;  // human-readable fallback + documentation
  rootPath: string;
  mappings: PathMapping[];
  excludedPaths: string[];
  filePermissions?: number;       // octal mode applied to uploaded files (e.g. 0o644)
  directoryPermissions?: number;  // octal mode applied to created directories (e.g. 0o755)
  timeOffsetMs?: number;          // clock skew in ms (remote minus local); detected via Test Connection
  hooks?: {                       // commands run before/after a deliberate deploy (#27)
    preDeploy?: HookCommand[];
    postDeploy?: HookCommand[];
  };
}

// What's stored in .vscode/fileferry.json — server name is the object key
export interface ProjectConfig {
  defaultServerId: string;   // server UUID (ProjectServer.id)
  uploadOnSave?: boolean;
  fileDateGuard?: boolean;   // warn before overwriting newer remote files (default: true)
  backupBeforeOverwrite?: boolean;  // download remote files before uploading (default: false)
  syncBackupBeforeDelete?: boolean; // back up each remote file before Sync delete-extras prunes it (default: true)
  backupRetentionDays?: number;     // days to keep backup folders (default: 7)
  backupMaxSizeMB?: number;         // max total backup size in MB (default: 100)
  dryRun?: boolean;                 // preview mode — show what would be deployed without transferring (default: false)
  historyMaxEntries?: number;        // max entries in upload history file (default: 10000, 0 disables logging)
  watch?: {                          // auto-upload generated/build-output files matching the globs (#25)
    enabled: boolean;
    patterns: string[];              // workspace-relative globs, e.g. ["dist/**", "build/**/*.js"]
  };
  servers: {
    [serverName: string]: ProjectServer;
  };
}
