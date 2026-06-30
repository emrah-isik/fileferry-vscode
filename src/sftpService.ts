import SftpClient from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServerConfig, UploadPair, UploadResult } from './types';
import { resolveAgentSocket } from './ssh/agentResolver';
import { resolveHostAlias, applySshConfig } from './ssh/SshConfigResolver';
import { TransferService, RemoteCommandResult, RemoteCommandRunner } from './transferService';

// Default algorithms that ensure compatibility with modern OpenSSH 8.8+ servers.
// ssh2 1.17.0 supports these natively — we set them explicitly so they can't be
// accidentally dropped by library updates and so users can override per-server.
const DEFAULT_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group14-sha1',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
  cipher: [
    'aes128-gcm',
    'aes128-gcm@openssh.com',
    'aes256-gcm',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
  ],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ],
};

function isPermissionDenied(err: { code?: string | number; message?: string }): boolean {
  if (err.code === 'EACCES' || err.code === 3) {
    return true;
  }
  return /permission denied/i.test(err.message ?? '');
}

export class SftpService implements TransferService, RemoteCommandRunner {
  private client: SftpClient | null = null;

  get connected(): boolean {
    return this.client !== null;
  }

  async connect(
    server: ServerConfig,
    credentials: { password?: string; passphrase?: string },
    options?: {
      hostVerifier?: (key: Buffer | string) => boolean | Promise<boolean>;
      keyboardInteractiveHandler?: (prompts: Array<{ prompt: string; echo: boolean }>) => Promise<string[]>;
    }
  ): Promise<void> {
    this.client = new SftpClient();

    // When the credential opts in, treat `host` as an ~/.ssh/config Host alias
    // and resolve HostName/Port/User/IdentityFile from the user's SSH config.
    if (server.useSshConfig) {
      server = applySshConfig(server, resolveHostAlias(server.host));
    }

    // Build the connection config based on auth method. ssh2-sftp-client's
    // ConnectOptions has optional fields that vary by auth method, so we
    // assemble it incrementally below.
    const connectConfig: SftpClient.ConnectOptions = {
      host: server.host,
      port: server.port,
      username: server.username,
      // ssh2 types `algorithms` with string-literal unions per category; our
      // values are plain string arrays validated at runtime, so narrow to the
      // library's expected shape here.
      algorithms: (server.algorithms ?? DEFAULT_ALGORITHMS) as SftpClient.ConnectOptions['algorithms'],
      ...(options?.hostVerifier ? { hostVerifier: options.hostVerifier } : {}),
    };

    if (server.authMethod === 'password') {
      connectConfig.password = credentials.password;
    } else if (server.authMethod === 'key') {
      const keyPath = server.privateKeyPath!.replace('~', os.homedir());
      try {
        connectConfig.privateKey = fs.readFileSync(keyPath);
      } catch {
        throw new Error(`Could not read private key file "${keyPath}". Check the file exists and is readable.`);
      }
      if (credentials.passphrase) {
        connectConfig.passphrase = credentials.passphrase;
      }
    } else if (server.authMethod === 'agent') {
      connectConfig.agent = resolveAgentSocket(server.agentSocketPath);
    } else if (server.authMethod === 'keyboard-interactive') {
      connectConfig.tryKeyboard = true;
    }

    // Register keyboard-interactive handler on the underlying ssh2 Client
    // before calling connect, so it's ready when the server sends a challenge.
    if (server.authMethod === 'keyboard-interactive' && options?.keyboardInteractiveHandler) {
      const handler = options.keyboardInteractiveHandler;
      // ssh2-sftp-client exposes the underlying ssh2 Client as `.client`, which
      // is not part of its published type surface. Reach through with a minimal
      // shape so we can register the keyboard-interactive challenge listener.
      const underlyingClient = (this.client as unknown as {
        client: {
          on(
            event: 'keyboard-interactive',
            listener: (
              name: string,
              instructions: string,
              lang: string,
              prompts: Array<{ prompt: string; echo: boolean }>,
              finish: (responses: string[]) => void
            ) => void
          ): void;
        };
      }).client;
      underlyingClient.on('keyboard-interactive',
        async (_name: string, _instructions: string, _lang: string,
          prompts: Array<{ prompt: string; echo: boolean }>,
          finish: (responses: string[]) => void) => {
          const responses = await handler(prompts);
          finish(responses);
        }
      );
    }

    try {
      await this.client.connect(connectConfig);
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('parse') && msg.toLowerCase().includes('privatekey')) {
        throw new Error('Could not parse private key file. Supported formats: OpenSSH, PEM, PPK');
      }
      throw err;
    }
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before uploading.');
    }

    // Atomic upload: write to a temp file, then rename in one operation.
    // If the transfer is interrupted, the original file remains intact.
    const tempPath = remotePath + '.fileferry.tmp';

    try {
      await this.client.put(localPath, tempPath);
    } catch (err: unknown) {
      const error = err as { code?: string | number; message?: string };
      // Remote directory doesn't exist — create it recursively and retry
      if (error.code === 'ERR_BAD_PATH' || error.message?.includes('No such file')) {
        const remoteDir = path.posix.dirname(remotePath);
        await this.client.mkdir(remoteDir, true);
        await this.client.put(localPath, tempPath);
      } else if (isPermissionDenied(error)) {
        // Target file is writable but the directory isn't (common on shared
        // hosting), so creating the sidecar temp file fails. Fall back to a
        // direct overwrite — non-atomic, but lets the upload succeed.
        await this.client.put(localPath, remotePath);
        return;
      } else {
        throw err;
      }
    }

    try {
      // posixRename uses OpenSSH's POSIX rename extension — atomic overwrite.
      // Falls back to regular rename (works when the target doesn't exist yet).
      try {
        await this.client.posixRename(tempPath, remotePath);
      } catch {
        await this.client.rename(tempPath, remotePath);
      }
    } catch (err: unknown) {
      // Clean up the orphaned temp file
      try {
        await this.client.delete(tempPath);
      } catch {
        // Best effort — ignore cleanup failure
      }
      throw err;
    }
  }

  // Downloads a remote file and returns its content as a Buffer.
  // Used by DiffService to fetch the remote version for side-by-side comparison.
  async get(remotePath: string): Promise<Buffer> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before downloading.');
    }
    const result = await this.client.get(remotePath);
    if (Buffer.isBuffer(result)) {
      return result;
    }
    // ssh2-sftp-client may return a string depending on options
    return Buffer.from(result as string);
  }

  async uploadFiles(
    pairs: UploadPair[],
    onProgress: (current: number, total: number, filename: string) => void
  ): Promise<UploadResult> {
    const result: UploadResult = { succeeded: [], failed: [] };

    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      onProgress(i + 1, pairs.length, path.basename(pair.localPath));

      try {
        await this.uploadFile(pair.localPath, pair.remotePath);
        result.succeeded.push(pair);
      } catch (err: unknown) {
        const error = err as { message?: string };
        result.failed.push({ pair, error: error.message ?? String(err) });
      }
    }

    return result;
  }

  async listDirectory(remotePath: string): Promise<Array<{ name: string; type: string }>> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before listing directories.');
    }
    const items = await this.client.list(remotePath);
    return items.map(item => ({ name: item.name, type: item.type }));
  }

  async listDirectoryDetailed(remotePath: string): Promise<SftpClient.FileInfo[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before listing directories.');
    }
    return this.client.list(remotePath);
  }

  async resolveRemotePath(remotePath: string): Promise<string> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before resolving paths.');
    }
    return await this.client.realPath(remotePath);
  }

  async statType(remotePath: string): Promise<'d' | '-' | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before stat.');
    }
    try {
      const stats = await this.client.stat(remotePath);
      return stats.isDirectory ? 'd' : '-';
    } catch {
      return null;
    }
  }

  async stat(remotePath: string): Promise<{ mtime: Date } | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before stat.');
    }
    try {
      // Typed (no `as any`) so the compiler enforces the field name: FileStats exposes
      // `modifyTime` (already in milliseconds — the library multiplies raw ssh2 seconds
      // by 1000), and has no `mtime`. Reading `stats.mtime` used to compile via the cast
      // and silently yield NaN, disabling every mtime comparison.
      const stats = await this.client.stat(remotePath);
      return { mtime: new Date(stats.modifyTime) };
    } catch (err: unknown) {
      // ssh2-sftp-client normalizes SFTP "no such file" to code === 'ENOENT'
      // (see node_modules/ssh2-sftp-client/src/constants.js). Returning null
      // here lets FileDateGuard treat a missing remote file as "new file, no conflict".
      const error = err as { code?: string | number };
      if (error.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before deleting files.');
    }
    await this.client.delete(remotePath);
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before deleting directories.');
    }
    await this.client.rmdir(remotePath, true);
  }

  async chmod(remotePath: string, mode: number): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before chmod.');
    }
    await this.client.chmod(remotePath, mode);
  }

  // Runs a shell command on the remote host over the same ssh2 connection the
  // SFTP session already holds — no second auth, the deploy's own context.
  // Returns stdout, stderr, and the raw exit code WITHOUT judging success:
  // many servers write benign chatter to stderr on a 0-exit command (MOTD,
  // login banners, shell-init/locale warnings), so judging on stderr would
  // abort deploys on noise. The caller decides on exitCode alone. A `null`
  // exitCode (channel closed via signal, or destroyed on timeout) is the real
  // failure case, distinct from a 0 exit with non-empty stderr.
  async execCommand(command: string, options?: { timeoutMs?: number }): Promise<RemoteCommandResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before running remote commands.');
    }

    // ssh2-sftp-client exposes the underlying ssh2 Client as `.client`, which is
    // not part of its published type surface. Reach through with a minimal shape
    // (same accessor the keyboard-interactive handler uses) to call `.exec()`.
    const underlyingClient = (this.client as unknown as {
      client: {
        exec(
          command: string,
          options: { pty: boolean },
          callback: (error: Error | undefined, channel: RemoteExecChannel) => void
        ): void;
      };
    }).client;

    return new Promise<RemoteCommandResult>((resolve, reject) => {
      // Deliberately pty:false — a PTY merges stdout+stderr and invites
      // login-shell banner noise; a plain exec channel keeps the streams
      // separate and quieter.
      underlyingClient.exec(command, { pty: false }, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }

        let stdout = '';
        let stderr = '';
        let exitCode: number | null = null;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          resolve({ stdout, stderr, exitCode });
        };

        if (options?.timeoutMs && options.timeoutMs > 0) {
          timer = setTimeout(() => {
            // A hung command can't be allowed to wedge the deploy: tear the
            // channel down and resolve with whatever was captured. exitCode
            // stays null, so the caller treats the timeout as a failure.
            channel.destroy();
            finish();
          }, options.timeoutMs);
        }

        channel.on('data', (data: Buffer) => { stdout += data.toString(); });
        channel.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        // 'exit' carries the real exit code (or null on a signal); 'close'
        // fires once the streams are fully drained, so we resolve there.
        channel.on('exit', (code: number | null) => { exitCode = code; });
        channel.on('close', () => { finish(); });
      });
    });
  }

  async disconnect(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }
}

// Minimal shape of the ssh2 exec channel we consume: a stdout stream emitting
// 'data'/'exit'/'close', a separate `stderr` stream, and `destroy()` for timeout.
interface RemoteExecChannel {
  on(event: 'data', listener: (data: Buffer) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'close', listener: () => void): void;
  stderr: { on(event: 'data', listener: (data: Buffer) => void): void };
  destroy(): void;
}
