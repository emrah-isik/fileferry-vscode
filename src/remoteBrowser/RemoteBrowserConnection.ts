import * as vscode from 'vscode';
import { SftpService } from '../sftpService';
import { CredentialManager } from '../storage/CredentialManager';
import { ServerManager } from '../storage/ServerManager';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';
import { ServerConfig } from '../types';
import SftpClient from 'ssh2-sftp-client';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class RemoteBrowserConnection {
  private sftp: SftpService;
  private currentServerId: string | null = null;
  private currentRootPath: string = '/';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
  readonly onDidDisconnect = this._onDidDisconnect.event;

  constructor(
    private readonly credentialManager: CredentialManager,
    private readonly serverManager: ServerManager,
    private readonly bindingManager: ProjectBindingManager,
    private readonly output: vscode.OutputChannel
  ) {
    this.sftp = new SftpService();
  }

  async ensureConnected(): Promise<void> {
    const binding = await this.bindingManager.getBinding();
    if (!binding || !binding.defaultServerId) {
      throw new Error('No server configured. Open Deployment Settings to add one.');
    }

    const server = await this.serverManager.getServer(binding.defaultServerId);
    if (!server) {
      throw new Error('Server not found. It may have been deleted.');
    }

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
      name: server.name,
      type: server.type,
      host: credential.host,
      port: credential.port,
      username: credential.username,
      authMethod: credential.authMethod,
      privateKeyPath: credential.privateKeyPath,
      mappings: [],
      excludedPaths: [],
    };

    await this.sftp.connect(serverConfig, {
      password: credential.password,
      passphrase: credential.passphrase,
    });

    this.currentServerId = server.id;
    const serverBinding = binding.servers?.[server.id];
    this.currentRootPath = serverBinding?.rootPathOverride || server.rootPath;
    this.output.appendLine(`[remote-browser] Connected to ${server.name} (${credential.host})`);
  }

  async listDirectory(remotePath: string): Promise<SftpClient.FileInfo[]> {
    await this.ensureConnected();
    this.resetIdleTimer();
    return this.sftp.listDirectoryDetailed(remotePath);
  }

  async downloadFile(remotePath: string): Promise<Buffer> {
    await this.ensureConnected();
    this.resetIdleTimer();
    return this.sftp.get(remotePath);
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
