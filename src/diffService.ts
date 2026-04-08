import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { ServerConfig } from './types';
import { TransferService } from './transferService';

// DiffService downloads the remote version of a file to a local temp directory
// so VSCode's built-in diff editor can compare it against the local copy.
//
// Temp files are named deterministically (hash of remote path) so the same
// file always maps to the same temp path — avoids duplicate downloads.
// All temp files are cleaned up when the extension deactivates.

export class DiffService {
  constructor(
    private readonly sftpService: TransferService,
    private readonly tempDir: string
  ) {}

  // Returns a stable temp path for a given remote path.
  // e.g. /var/www/index.php → /tmp/fileferry/index.remote.a1b2c3d4.php
  private getTempPath(remotePath: string): string {
    const hash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
    const ext = path.extname(remotePath);
    const base = path.basename(remotePath, ext);
    return path.join(this.tempDir, `${base}.remote.${hash}${ext}`);
  }

  // Downloads the remote file and writes it to the temp directory.
  // Returns the local temp path — ready to open in VSCode's diff editor.
  async downloadRemoteFile(
    server: ServerConfig,
    credentials: { password?: string; passphrase?: string },
    remotePath: string
  ): Promise<string> {
    await this.sftpService.connect(server, credentials);
    try {
      const content = await this.sftpService.get(remotePath);
      const tempPath = this.getTempPath(remotePath);
      await fs.mkdir(this.tempDir, { recursive: true });
      await fs.writeFile(tempPath, content);
      return tempPath;
    } finally {
      // Always disconnect — even if download or write fails
      await this.sftpService.disconnect();
    }
  }

  // Removes all temp files. Called on extension deactivation.
  async cleanup(): Promise<void> {
    await fs.rm(this.tempDir, { recursive: true, force: true });
  }
}
