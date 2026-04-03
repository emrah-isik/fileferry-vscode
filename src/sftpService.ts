import SftpClient from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServerConfig, UploadPair, UploadResult } from './types';

export class SftpService {
  private client: SftpClient | null = null;

  get connected(): boolean {
    return this.client !== null;
  }

  async connect(
    server: ServerConfig,
    credentials: { password?: string; passphrase?: string }
  ): Promise<void> {
    this.client = new SftpClient();

    // Build the connection config based on auth method.
    // TypeScript uses `any` here because ssh2-sftp-client's ConnectConfig
    // has optional fields that vary by auth method.
    const connectConfig: Record<string, unknown> = {
      host: server.host,
      port: server.port,
      username: server.username,
    };

    if (server.authMethod === 'password') {
      connectConfig.password = credentials.password;
    } else if (server.authMethod === 'key') {
      const keyPath = server.privateKeyPath!.replace('~', os.homedir());
      connectConfig.privateKey = fs.readFileSync(keyPath);
      if (credentials.passphrase) {
        connectConfig.passphrase = credentials.passphrase;
      }
    } else if (server.authMethod === 'agent') {
      // SSH agent forwards auth from the OS keychain (e.g. ssh-agent, Pageant)
      connectConfig.agent = process.env.SSH_AUTH_SOCK ?? 'pageant';
    }

    await this.client.connect(connectConfig as any);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before uploading.');
    }

    try {
      await this.client.put(localPath, remotePath);
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      // Remote directory doesn't exist — create it recursively and retry
      if (error.code === 'ERR_BAD_PATH' || error.message?.includes('No such file')) {
        const remoteDir = path.posix.dirname(remotePath);
        await this.client.mkdir(remoteDir, true);
        await this.client.put(localPath, remotePath);
      } else {
        throw err;
      }
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

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before deleting files.');
    }
    await (this.client as any).delete(remotePath);
  }

  async disconnect(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }
}
