import type { CancellationToken } from 'vscode';
import { TransferService } from '../transferService';
import { SftpService } from '../sftpService';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { ResolvedUploadItem } from '../path/PathResolver';

export interface UploadSummaryV2 {
  succeeded: ResolvedUploadItem[];
  failed: Array<{ localPath: string; error: string }>;
  deleted: string[];
  deleteFailed: Array<{ remotePath: string; error: string }>;
  cancelled?: ResolvedUploadItem[];
}

export class UploadOrchestratorV2 {
  constructor(private readonly sftp: TransferService = new SftpService()) {}

  async upload(
    items: ResolvedUploadItem[],
    credential: SshCredentialWithSecret,
    _server: { filePermissions?: number; directoryPermissions?: number } | null,
    deleteRemotePaths: string[] = [],
    token?: CancellationToken
  ): Promise<UploadSummaryV2> {
    await this.sftp.connect(credential as any, {
      password: credential.password,
      passphrase: credential.passphrase,
    });

    const result: UploadSummaryV2 = { succeeded: [], failed: [], deleted: [], deleteFailed: [] };

    try {
      for (let i = 0; i < items.length; i++) {
        if (token?.isCancellationRequested) {
          result.cancelled = items.slice(i);
          break;
        }
        try {
          await this.sftp.uploadFile(items[i].localPath, items[i].remotePath);
          if (_server?.filePermissions !== undefined) {
            try {
              await this.sftp.chmod(items[i].remotePath, _server.filePermissions);
            } catch {
              // chmod is best-effort — don't fail the upload
            }
          }
          result.succeeded.push(items[i]);
        } catch (err: unknown) {
          result.failed.push({
            localPath: items[i].localPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!token?.isCancellationRequested) {
        for (const remotePath of deleteRemotePaths) {
          try {
            await this.sftp.deleteFile(remotePath);
            result.deleted.push(remotePath);
          } catch (err: unknown) {
            result.deleteFailed.push({
              remotePath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        result.cancelled = result.cancelled ?? [];
      }
    } finally {
      await this.sftp.disconnect();
    }

    return result;
  }
}
