import type { ResolverDeps } from './ssh/SshConfigResolver';
import type { KeyboardInteractiveProvider } from './ssh/connectProviders';
import type { ConnectTarget } from './connectTarget';
export interface FileEntry {
  name: string;
  type: 'd' | '-' | 'l';
  size: number;
  modifyTime: number;
  // Octal permission mode ("644", "2775") when the server's listing reports
  // one — SFTP always does, FTP only for unix-style LIST output. Absent
  // otherwise; consumers must not assume it (feature 33e chmod prefill).
  mode?: string;
}

export interface TransferService {
  readonly connected: boolean;

  connect(
    // Requires the server `type` (not on a credential) — see src/connectTarget.ts.
    server: ConnectTarget,
    credentials: { password?: string; passphrase?: string },
    options?: {
      /** ssh2 callback form ONLY — return `undefined`, verdict via `verify(permitted)`. See SftpService. */
      hostVerifier?: (key: Buffer, verify: (permitted: boolean) => void) => void;
      /** Answers keyboard-interactive challenges; bypasses the registry's provider. */
      keyboardInteractive?: KeyboardInteractiveProvider;
      /**
       * `false` = background connect: never prompt, still verify — fails fast
       * with a typed `InteractionRequiredError` (src/ssh/connectErrors.ts)
       * when verification would need the user. Default `true`. FTP/FTPS
       * transports ignore it (they never prompt).
       */
      interactive?: boolean;
      /**
       * Cancels the connect from outside (18a-2b): the promise rejects with
       * `ConnectionCancelledError`, resources are torn down, and any open
       * prompt is dismissed. FTP/FTPS transports ignore it.
       */
      signal?: AbortSignal;
      /**
       * `~/.ssh/config` access for alias credentials and ProxyJump chains
       * (18b). Production leaves it unset (the real file); tests inject a
       * reader. FTP/FTPS transports ignore it.
       */
      sshConfig?: ResolverDeps;
    }
  ): Promise<void>;

  /**
   * Canonical pool keys (`user@host:port`) of the jump hosts the CURRENT
   * session tunnels through, in route order — empty for a direct session or
   * a transport without chains. Consumers match `JumpHostPool.onDidEvict`
   * against it (Q34).
   */
  readonly routeKeys?: readonly string[];

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
  rename(oldPath: string, newPath: string): Promise<void>;
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
