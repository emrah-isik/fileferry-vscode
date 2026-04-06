import * as path from 'path';
import * as fsPromises from 'fs/promises';
import { SftpService } from '../sftpService';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { ResolvedUploadItem } from '../path/PathResolver';

const BACKUP_DIR = path.join('.vscode', 'fileferry-backups');

export class BackupService {
  constructor(private readonly sftp: SftpService = new SftpService()) {}

  async backup(
    items: ResolvedUploadItem[],
    credential: SshCredentialWithSecret,
    serverName: string,
    workspaceRoot: string
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    await this.sftp.connect(credential as any, {
      password: credential.password,
      passphrase: credential.passphrase,
    });

    try {
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
      const backupRoot = path.join(workspaceRoot, BACKUP_DIR, `${timestamp}-${serverName}`);

      for (const item of items) {
        const remoteStat = await this.sftp.stat(item.remotePath);
        if (!remoteStat) {
          continue; // New file — nothing to back up
        }

        const content = await this.sftp.get(item.remotePath);
        // Mirror remote path structure under backup folder
        const relativePath = item.remotePath.startsWith('/')
          ? item.remotePath.slice(1)
          : item.remotePath;
        const backupPath = path.join(backupRoot, relativePath);
        await fsPromises.mkdir(path.dirname(backupPath), { recursive: true });
        await fsPromises.writeFile(backupPath, content);
      }
    } finally {
      await this.sftp.disconnect();
    }
  }

  async cleanup(
    workspaceRoot: string,
    retentionDays: number,
    maxSizeMB: number
  ): Promise<void> {
    const backupRoot = path.join(workspaceRoot, BACKUP_DIR);

    let entries: string[];
    try {
      entries = await fsPromises.readdir(backupRoot);
    } catch {
      return; // Backup directory doesn't exist yet
    }

    // Filter to directories only
    const dirs: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(backupRoot, entry);
      const stat = await fsPromises.stat(fullPath);
      if (stat.isDirectory()) {
        dirs.push(entry);
      }
    }

    // Sort naturally (ISO timestamps sort lexicographically)
    dirs.sort();

    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    // Step 1: Delete folders older than retentionDays
    const remaining: string[] = [];
    for (const dir of dirs) {
      const timestamp = this.parseTimestamp(dir);
      if (timestamp && now - timestamp.getTime() > retentionMs) {
        await fsPromises.rm(path.join(backupRoot, dir), { recursive: true });
      } else {
        remaining.push(dir);
      }
    }

    // Step 2: If total size exceeds maxSizeMB, delete oldest until under limit
    const maxBytes = maxSizeMB * 1024 * 1024;
    let totalSize = 0;
    const sizes: Map<string, number> = new Map();

    for (const dir of remaining) {
      const size = await this.getDirSize(path.join(backupRoot, dir));
      sizes.set(dir, size);
      totalSize += size;
    }

    let i = 0;
    while (totalSize > maxBytes && i < remaining.length) {
      const dir = remaining[i];
      await fsPromises.rm(path.join(backupRoot, dir), { recursive: true });
      totalSize -= sizes.get(dir) ?? 0;
      i++;
    }
  }

  private parseTimestamp(dirName: string): Date | null {
    // Format: YYYY-MM-DDTHH-MM-SS-ServerName
    const match = dirName.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
    if (!match) {
      return null;
    }
    // Convert back to ISO format for parsing
    const isoString = match[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2') + 'Z';
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? null : date;
  }

  private async getDirSize(dirPath: string): Promise<number> {
    let total = 0;
    const names = await fsPromises.readdir(dirPath);
    for (const name of names) {
      const fullPath = path.join(dirPath, name as string);
      const stat = await fsPromises.stat(fullPath);
      if (stat.isDirectory()) {
        total += await this.getDirSize(fullPath);
      } else {
        total += stat.size;
      }
    }
    return total;
  }
}
