export interface FileEntry {
  name: string;
  type: 'd' | '-' | 'l';
  size: number;
  modifyTime: number;
}

export interface TransferService {
  readonly connected: boolean;

  connect(
    server: unknown,
    credentials: { password?: string; passphrase?: string },
    options?: {
      hostVerifier?: (key: Buffer | string) => boolean | Promise<boolean>;
      keyboardInteractiveHandler?: (prompts: Array<{ prompt: string; echo: boolean }>) => Promise<string[]>;
    }
  ): Promise<void>;

  uploadFile(localPath: string, remotePath: string): Promise<void>;
  get(remotePath: string): Promise<Buffer>;
  listDirectory(remotePath: string): Promise<Array<{ name: string; type: string }>>;
  listDirectoryDetailed(remotePath: string): Promise<FileEntry[]>;
  resolveRemotePath(remotePath: string): Promise<string>;
  statType(remotePath: string): Promise<'d' | '-' | null>;
  stat(remotePath: string): Promise<{ mtime: Date } | null>;
  mkdir(remotePath: string, recursive?: boolean): Promise<void>;
  exists(remotePath: string): Promise<boolean>;
  deleteFile(remotePath: string): Promise<void>;
  deleteDirectory(remotePath: string): Promise<void>;
  chmod(remotePath: string, mode: number): Promise<void>;
  disconnect(): Promise<void>;
}

export interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  // The command's exit code. `null` means the channel closed without reporting
  // an exit (killed by a signal, or destroyed on timeout) — distinct from 0.
  exitCode: number | null;
}

// A narrow, optional capability for running a shell command on the remote host
// over an already-open connection. Deliberately kept SEPARATE from
// TransferService: only SSH-based transports (SFTP) can exec, so FTP/FTPS
// implementations must not be forced to provide it. Callers narrow with a
// user-defined type predicate before using it (see feature 27 / deploy hooks).
//
// execCommand makes NO pass/fail judgment: it returns stdout, stderr, and the
// raw exitCode unmodified. A non-empty stderr on a 0 exit (MOTD, login banners,
// shell-init/locale warnings) is a SUCCESS — the caller decides on exitCode
// only, never on the presence of stderr.
export interface RemoteCommandRunner {
  execCommand(command: string, options?: { timeoutMs?: number }): Promise<RemoteCommandResult>;
}

// Narrows a TransferService to one that can also run remote commands (SFTP).
// A user-defined type predicate, NOT a bare `in` check: `transfer` is typed
// TransferService (no execCommand), so `'execCommand' in transfer` alone would
// not narrow the type and the compiler would still reject the call. The runtime
// `typeof === 'function'` guard also rules out a stray non-function property.
export function canExec(service: TransferService): service is TransferService & RemoteCommandRunner {
  return 'execCommand' in service && typeof (service as { execCommand?: unknown }).execCommand === 'function';
}
