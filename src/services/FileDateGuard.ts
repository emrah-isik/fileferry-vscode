import * as fs from 'fs';
import { TransferService } from '../transferService';
import { SftpService } from '../sftpService';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { ResolvedUploadItem } from '../path/PathResolver';

export class FileDateGuard {
  constructor(private readonly sftp: TransferService = new SftpService()) {}

  async check(
    items: ResolvedUploadItem[],
    credential: SshCredentialWithSecret
  ): Promise<ResolvedUploadItem[]> {
    if (items.length === 0) {
      return [];
    }

    await this.sftp.connect(credential as any, {
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
        if (remoteStat.mtime.getTime() > localStat.mtimeMs) {
          newerOnRemote.push(item);
        }
      }

      return newerOnRemote;
    } finally {
      await this.sftp.disconnect();
    }
  }
}
