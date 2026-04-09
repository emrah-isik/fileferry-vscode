import { Client as FtpClient } from 'basic-ftp';
import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';
import { TransferService, FileEntry } from './transferService';

export class FtpService implements TransferService {
  private client: FtpClient | null = null;

  get connected(): boolean {
    return this.client !== null && !this.client.closed;
  }

  async connect(
    server: any,
    credentials: { password?: string; passphrase?: string },
    _options?: unknown
  ): Promise<void> {
    this.client = new FtpClient();

    let secure: boolean | 'implicit' = false;
    if (server.type === 'ftps') {
      secure = true;
    } else if (server.type === 'ftps-implicit') {
      secure = 'implicit';
    }

    await this.client.access({
      host: server.host,
      port: server.port,
      user: server.username,
      password: credentials.password ?? '',
      secure,
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before uploading.');
    }

    const tempPath = remotePath + '.fileferry.tmp';
    const stream = fs.createReadStream(localPath);

    try {
      await this.client.uploadFrom(stream, tempPath);
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('No such file') || msg.includes('550')) {
        const remoteDir = path.posix.dirname(remotePath);
        await this.client.ensureDir(remoteDir);
        await this.client.uploadFrom(stream, tempPath);
      } else {
        throw err;
      }
    }

    try {
      await this.client.rename(tempPath, remotePath);
    } catch (err: unknown) {
      try {
        await this.client.remove(tempPath);
      } catch {
        // Best effort cleanup
      }
      throw err;
    }
  }

  async get(remotePath: string): Promise<Buffer> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before downloading.');
    }

    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });

    await this.client.downloadTo(writable, remotePath);
    return Buffer.concat(chunks);
  }

  async listDirectory(remotePath: string): Promise<Array<{ name: string; type: string }>> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before listing directories.');
    }
    const items = await this.client.list(remotePath);
    return items.map(item => ({
      name: item.name,
      type: this.mapType(item),
    }));
  }

  async listDirectoryDetailed(remotePath: string): Promise<FileEntry[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before listing directories.');
    }
    const items = await this.client.list(remotePath);
    return items.map(item => ({
      name: item.name,
      type: this.mapType(item) as 'd' | '-' | 'l',
      size: item.size,
      modifyTime: item.modifiedAt ? item.modifiedAt.getTime() : 0,
    }));
  }

  async resolveRemotePath(remotePath: string): Promise<string> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before resolving paths.');
    }
    if (remotePath === '.') {
      return this.client.pwd();
    }
    return remotePath;
  }

  async statType(remotePath: string): Promise<'d' | '-' | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before stat.');
    }
    // Try cd — if it works, it's a directory
    try {
      await this.client.cd(remotePath);
      return 'd';
    } catch {
      // Not a directory — check if file exists via parent listing
    }

    const dirName = path.posix.dirname(remotePath);
    const baseName = path.posix.basename(remotePath);
    try {
      const items = await this.client.list(dirName);
      const match = items.find(i => i.name === baseName);
      return match ? '-' : null;
    } catch {
      return null;
    }
  }

  async stat(remotePath: string): Promise<{ mtime: Date } | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before stat.');
    }

    const dirName = path.posix.dirname(remotePath);
    const baseName = path.posix.basename(remotePath);
    try {
      const items = await this.client.list(dirName);
      const match = items.find(i => i.name === baseName);
      if (!match) {
        return null;
      }
      return { mtime: match.modifiedAt ?? new Date(0) };
    } catch {
      return null;
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before deleting files.');
    }
    await this.client.remove(remotePath);
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before deleting directories.');
    }
    await this.client.removeDir(remotePath);
  }

  async chmod(remotePath: string, mode: number): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() before chmod.');
    }
    const octal = mode.toString(8);
    try {
      await this.client.send(`SITE CHMOD ${octal} ${remotePath}`);
    } catch {
      // FTP SITE CHMOD is server-dependent — silently ignore if unsupported
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  private mapType(item: { isDirectory: boolean; isSymbolicLink: boolean }): string {
    if (item.isSymbolicLink) { return 'l'; }
    if (item.isDirectory) { return 'd'; }
    return '-';
  }
}
