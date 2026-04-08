import SftpClient from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServerConfig, UploadPair, UploadResult } from './types';
import { resolveAgentSocket } from './ssh/agentResolver';

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

export class SftpService {
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

    // Build the connection config based on auth method.
    // TypeScript uses `any` here because ssh2-sftp-client's ConnectConfig
    // has optional fields that vary by auth method.
    const connectConfig: Record<string, unknown> = {
      host: server.host,
      port: server.port,
      username: server.username,
      algorithms: server.algorithms ?? DEFAULT_ALGORITHMS,
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
      (this.client as any).client.on('keyboard-interactive',
        async (_name: string, _instructions: string, _lang: string,
          prompts: Array<{ prompt: string; echo: boolean }>,
          finish: (responses: string[]) => void) => {
          const responses = await handler(prompts);
          finish(responses);
        }
      );
    }

    try {
      await this.client.connect(connectConfig as any);
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
      const error = err as { code?: string; message?: string };
      // Remote directory doesn't exist — create it recursively and retry
      if (error.code === 'ERR_BAD_PATH' || error.message?.includes('No such file')) {
        const remoteDir = path.posix.dirname(remotePath);
        await this.client.mkdir(remoteDir, true);
        await this.client.put(localPath, tempPath);
      } else {
        throw err;
      }
    }

    try {
      // posixRename uses OpenSSH's POSIX rename extension — atomic overwrite.
      // Falls back to regular rename (works when the target doesn't exist yet).
      try {
        await (this.client as any).posixRename(tempPath, remotePath);
      } catch {
        await (this.client as any).rename(tempPath, remotePath);
      }
    } catch (err: unknown) {
      // Clean up the orphaned temp file
      try {
        await (this.client as any).delete(tempPath);
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
    const result = await (this.client as any).get(remotePath);
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
    return await (this.client as any).realPath(remotePath);
  }

  async statType(remotePath: string): Promise<'d' | '-' | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before stat.');
    }
    try {
      const stats = await (this.client as any).stat(remotePath);
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
      const stats = await (this.client as any).stat(remotePath);
      return { mtime: new Date(stats.mtime * 1000) };
    } catch (err: unknown) {
      const error = err as { code?: number };
      if (error.code === 2) {
        return null; // File does not exist
      }
      throw err;
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before deleting files.');
    }
    await (this.client as any).delete(remotePath);
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before deleting directories.');
    }
    await this.client.rmdir(remotePath, true);
  }

  async disconnect(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }
}
