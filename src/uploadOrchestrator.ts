import { GitFile, ServerConfig, UploadResult } from './types';
import { SftpService } from './sftpService';
import { ConfigManager } from './configManager';
import { SecretManager } from './secretManager';

export interface UploadSummary {
  succeeded: Array<{ localPath: string; remotePath: string }>;
  failed: Array<{ localPath: string; error: string }>;
  skipped: string[]; // absolute paths with no matching remote mapping
}

// UploadOrchestrator coordinates the full upload flow.
// All dependencies are injected — making this fully testable without real network calls.
//
// In PHP terms, this is like a Service class that depends on injected Repository objects.
export class UploadOrchestrator {
  constructor(
    private sftp: SftpService,
    private config: ConfigManager,
    private secrets: SecretManager
  ) {}

  async upload(
    files: GitFile[],
    serverId: string,
    onProgress: (current: number, total: number, filename: string) => void
  ): Promise<UploadSummary> {
    // 1. Load config and find the target server
    const ferryConfig = await this.config.loadConfig();
    const server = ferryConfig.servers.find(s => s.id === serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found in fileferry.json`);
    }

    // 2. Resolve local → remote path for each file
    const pairs: Array<{ localPath: string; remotePath: string }> = [];
    const skipped: string[] = [];

    for (const file of files) {
      const remotePath = this.config.resolveRemotePath(
        server as ServerConfig,
        file.absolutePath,
        file.workspaceRoot
      );
      if (remotePath === null) {
        skipped.push(file.absolutePath);
      } else {
        pairs.push({ localPath: file.absolutePath, remotePath });
      }
    }

    // 3. Get credentials from OS keychain
    const credentials: { password?: string; passphrase?: string } = {};
    if (server.authMethod === 'password') {
      credentials.password = await this.secrets.getPassword(serverId);
    } else if (server.authMethod === 'key') {
      credentials.passphrase = await this.secrets.getPassphrase(serverId);
    }

    // 4. Connect, upload, always disconnect (try/finally guarantees cleanup)
    await this.sftp.connect(server as ServerConfig, credentials);
    try {
      const result: UploadResult = await this.sftp.uploadFiles(pairs, onProgress);
      return {
        succeeded: result.succeeded,
        failed: result.failed.map(f => ({
          localPath: f.pair.localPath,
          error: f.error
        })),
        skipped
      };
    } finally {
      await this.sftp.disconnect();
    }
  }
}
