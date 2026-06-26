import * as fs from 'fs';
import { TransferService } from '../transferService';
import { SftpService } from '../sftpService';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { ResolvedUploadItem } from '../path/PathResolver';

export interface SkippedItem {
  item: ResolvedUploadItem;
  remoteMtimeMs: number; // offset-adjusted remote mtime, for reporting
  reason: 'same-age' | 'remote-newer';
}

export interface NewerPartition {
  toUpload: ResolvedUploadItem[];
  skipped: SkippedItem[];
}

export class FileDateGuard {
  constructor(private readonly sftp: TransferService = new SftpService()) {}

  async check(
    items: ResolvedUploadItem[],
    credential: SshCredentialWithSecret,
    timeOffsetMs?: number
  ): Promise<ResolvedUploadItem[]> {
    if (items.length === 0) {
      return [];
    }

    await this.sftp.connect(credential, {
      password: credential.password,
      passphrase: credential.passphrase,
    });

    try {
      const newerOnRemote: ResolvedUploadItem[] = [];

      for (const item of items) {
        const remoteStat = await this.sftp.stat(item.remotePath);
        if (!remoteStat) {
          continue; // New file — no conflict
        }

        const localStat = fs.statSync(item.localPath);
        const adjustedRemoteMtime = remoteStat.mtime.getTime() - (timeOffsetMs ?? 0);
        if (adjustedRemoteMtime > localStat.mtimeMs) {
          newerOnRemote.push(item);
        }
      }

      return newerOnRemote;
    } finally {
      await this.sftp.disconnect();
    }
  }

  /**
   * Partitions items for upload-only-newer (feature 21b): a file is uploaded when it is
   * missing on the remote or strictly newer locally, and skipped when the remote copy is
   * the same age or newer (offset-adjusted). Unlike {@link check}, the skip boundary is
   * inclusive (`>=`) so equal-age files are held back, not pushed.
   */
  async partitionByNewerLocal(
    items: ResolvedUploadItem[],
    credential: SshCredentialWithSecret,
    timeOffsetMs?: number
  ): Promise<NewerPartition> {
    if (items.length === 0) {
      return { toUpload: [], skipped: [] };
    }

    await this.sftp.connect(credential, {
      password: credential.password,
      passphrase: credential.passphrase,
    });

    try {
      const toUpload: ResolvedUploadItem[] = [];
      const skipped: SkippedItem[] = [];

      for (const item of items) {
        const remoteStat = await this.sftp.stat(item.remotePath);
        if (!remoteStat) {
          toUpload.push(item); // New file — nothing to compare against
          continue;
        }

        const localStat = fs.statSync(item.localPath);
        const adjustedRemoteMtime = remoteStat.mtime.getTime() - (timeOffsetMs ?? 0);
        if (localStat.mtimeMs > adjustedRemoteMtime) {
          toUpload.push(item);
        } else {
          skipped.push({
            item,
            remoteMtimeMs: adjustedRemoteMtime,
            reason: adjustedRemoteMtime === localStat.mtimeMs ? 'same-age' : 'remote-newer',
          });
        }
      }

      return { toUpload, skipped };
    } finally {
      await this.sftp.disconnect();
    }
  }
}
