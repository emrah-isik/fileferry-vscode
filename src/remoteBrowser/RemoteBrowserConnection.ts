import * as vscode from 'vscode';
import { SftpService } from '../sftpService';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ServerConfig } from '../types';
import { HostKeyManager } from '../ssh/HostKeyManager';
import { showHostKeyPrompt } from '../ssh/hostKeyPrompt';
import SftpClient from 'ssh2-sftp-client';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class RemoteBrowserConnection {
  private sftp: SftpService;
  private hostKeyManager: HostKeyManager;
  private currentServerId: string | null = null;
  private currentRootPath: string = '/';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
  readonly onDidDisconnect = this._onDidDisconnect.event;

  constructor(
    private readonly credentialManager: CredentialManager,
    private readonly configManager: ProjectConfigManager,
    private readonly output: vscode.OutputChannel,
    globalStoragePath: string
  ) {
    this.sftp = new SftpService();
    this.hostKeyManager = new HostKeyManager(globalStoragePath);
  }

  async ensureConnected(): Promise<void> {
    const config = await this.configManager.getConfig();
    if (!config || !config.defaultServerId) {
      throw new Error('No server configured. Open Deployment Settings to add one.');
    }

    const match = await this.configManager.getServerById(config.defaultServerId);
    if (!match) {
      throw new Error('Server not found. It may have been deleted.');
    }

    const { name: serverName, server } = match;

    // Already connected to the same server — no-op
    if (server.id === this.currentServerId && this.sftp.connected) {
      return;
    }

    // Connected to a different server — disconnect first
    if (this.sftp.connected) {
      await this.sftp.disconnect();
    }

    const credential = await this.credentialManager.getWithSecret(server.credentialId);

    const serverConfig: ServerConfig = {
      id: server.id,
      name: serverName,
      type: server.type,
      host: credential.host,
      port: credential.port,
      username: credential.username,
      authMethod: credential.authMethod,
      privateKeyPath: credential.privateKeyPath,
      mappings: [],
      excludedPaths: [],
    };

    const hostKeyMgr = this.hostKeyManager;
    const host = credential.host;
    const port = credential.port;

    await this.sftp.connect(serverConfig, {
      password: credential.password,
      passphrase: credential.passphrase,
    }, {
      hostVerifier: async (key: Buffer | string) => {
        const keyBase64 = Buffer.isBuffer(key) ? key.toString('base64') : key;
        const status = await hostKeyMgr.check(host, port, 'ssh-unknown', keyBase64);

        if (status === 'trusted') {
          return true;
        }

        const fingerprint = hostKeyMgr.getFingerprint(keyBase64);
        const accepted = await showHostKeyPrompt(host, port, fingerprint, status);

        if (accepted) {
          await hostKeyMgr.trust(host, port, 'ssh-unknown', keyBase64);
        }
        return accepted;
      },
    });

    this.currentServerId = server.id;
    this.currentRootPath = server.rootPath;
    this.output.appendLine(`[remote-browser] Connected to ${serverName} (${credential.host})`);
  }

  async listDirectory(remotePath: string): Promise<SftpClient.FileInfo[]> {
    await this.ensureConnected();
    this.resetIdleTimer();
    return this.sftp.listDirectoryDetailed(remotePath);
  }

  async resolveSymlinkTargets(
    entries: SftpClient.FileInfo[],
    parentPath: string
  ): Promise<Map<string, 'd' | '-' | null>> {
    const result = new Map<string, 'd' | '-' | null>();
    const symlinks = entries.filter(e => e.type === 'l');
    await Promise.all(
      symlinks.map(async (entry) => {
        const fullPath = parentPath === '/'
          ? `/${entry.name}`
          : `${parentPath}/${entry.name}`;
        const target = await this.sftp.statType(fullPath);
        result.set(entry.name, target);
      })
    );
    return result;
  }

  async downloadFile(remotePath: string): Promise<Buffer> {
    await this.ensureConnected();
    this.resetIdleTimer();
    return this.sftp.get(remotePath);
  }

  async deleteRemoteFile(remotePath: string): Promise<void> {
    await this.ensureConnected();
    this.resetIdleTimer();
    await this.sftp.deleteFile(remotePath);
  }

  async deleteRemoteDirectory(remotePath: string): Promise<void> {
    await this.ensureConnected();
    this.resetIdleTimer();
    await this.sftp.deleteDirectory(remotePath);
  }

  async disconnect(): Promise<void> {
    this.clearIdleTimer();
    if (this.sftp.connected) {
      await this.sftp.disconnect();
      this._onDidDisconnect.fire();
    }
    this.currentServerId = null;
  }

  getRootPath(): string {
    return this.currentRootPath;
  }

  dispose(): void {
    this.clearIdleTimer();
    this._onDidDisconnect.dispose();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(async () => {
      this.output.appendLine('[remote-browser] Idle timeout — disconnecting');
      await this.disconnect();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
