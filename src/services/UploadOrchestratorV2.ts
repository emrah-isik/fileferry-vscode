import { SftpService } from '../sftpService';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { DeploymentServer } from '../models/DeploymentServer';
import { ResolvedUploadItem } from '../path/PathResolver';

export interface UploadSummaryV2 {
  succeeded: ResolvedUploadItem[];
  failed: Array<{ localPath: string; error: string }>;
  deleted: string[];
  deleteFailed: Array<{ remotePath: string; error: string }>;
}

export class UploadOrchestratorV2 {
  constructor(private readonly sftp: SftpService = new SftpService()) {}

  async upload(
    items: ResolvedUploadItem[],
    credential: SshCredentialWithSecret,
    _server: DeploymentServer,
    deleteRemotePaths: string[] = []
  ): Promise<UploadSummaryV2> {
    await this.sftp.connect(credential as any, {
      password: credential.password,
      passphrase: credential.passphrase,
    });

    const result: UploadSummaryV2 = { succeeded: [], failed: [], deleted: [], deleteFailed: [] };

    try {
      for (const item of items) {
        try {
          await this.sftp.uploadFile(item.localPath, item.remotePath);
          result.succeeded.push(item);
        } catch (err: unknown) {
          result.failed.push({
            localPath: item.localPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

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
    } finally {
      await this.sftp.disconnect();
    }

    return result;
  }
}
