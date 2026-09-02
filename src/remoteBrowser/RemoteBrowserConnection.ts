import * as vscode from 'vscode';
import { TransferService, FileEntry } from '../transferService';
import { createTransferService } from '../transferServiceFactory';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ServerConfig } from '../types';
import { JumpHostPool } from '../ssh/JumpHostPool';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class RemoteBrowserConnection {
  private sftp: TransferService;
  private currentServerId: string | null = null;
  private currentCredentialId: string | null = null;
  private currentRootPath: string = '/';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly configSaveSubscription: vscode.Disposable;
  private readonly credentialChangeSubscription: vscode.Disposable;

  // Pool keys of the hops the CURRENT session tunnels through (18a-2b, Q34).
  // Empty for unchained sessions; cleared on disconnect.
  private currentRouteKeys = new Set<string>();
  private readonly poolEvictSubscription: { dispose(): void } | undefined;

  private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
  readonly onDidDisconnect = this._onDidDisconnect.event;

  // Fired when a hop on the current route was evicted from the pool
  // (unexpected close, credential change) — the session's tunnel is dead.
  private readonly _onDidLoseRoute = new vscode.EventEmitter<string>();
  readonly onDidLoseRoute = this._onDidLoseRoute.event;

  constructor(
    private readonly credentialManager: CredentialManager,
    private readonly configManager: ProjectConfigManager,
    private readonly output: vscode.OutputChannel,
    jumpHostPool?: Pick<JumpHostPool, 'onDidEvict'>
  ) {
    this.sftp = createTransferService('sftp');
    this.configSaveSubscription = this.configManager.onDidSaveConfig(() => {
      void this.handleConfigSaved();
    });
    // 18a-2b, H3: an open session must not survive editing/deleting its own
    // credential — it authenticated with the old host/user/auth. Drop it; the
    // next operation reconnects with the current data.
    this.credentialChangeSubscription = this.credentialManager.onDidChange((event) => {
      if (event.id === this.currentCredentialId) {
        this.output.appendLine('[remote-browser] Session credential changed — disconnecting');
        return this.disconnect();
      }
    });
    this.poolEvictSubscription = jumpHostPool?.onDidEvict((key) => {
      if (this.currentRouteKeys.has(key)) {
        this.output.appendLine(`[remote-browser] Jump host ${key} on the current route was evicted`);
        this._onDidLoseRoute.fire(key);
      }
    });
  }

  private async handleConfigSaved(): Promise<void> {
    if (!this.sftp.connected) { return; }

    try {
      const config = await this.configManager.getConfig();
      if (!config || !config.defaultServerId) {
        await this.disconnect();
        return;
      }

      const match = await this.configManager.getServerById(config.defaultServerId);
      if (!match) {
        await this.disconnect();
        return;
      }

      const { server } = match;
      // Identity change (different default server, or credential swap on the
      // active one) — drop the session so the next operation reconnects with
      // the correct host/auth.
      if (server.id !== this.currentServerId || server.credentialId !== this.currentCredentialId) {
        await this.disconnect();
        return;
      }

      // Same identity — only non-connection fields may have changed
      // (rootPath, mappings, etc). Keep the session, refresh cached rootPath.
      if (server.rootPath !== this.currentRootPath) {
        this.output.appendLine(`[remote-browser] Root path updated: ${this.currentRootPath} → ${server.rootPath}`);
        this.currentRootPath = server.rootPath;
      }
    } catch (err) {
      this.output.appendLine(`[remote-browser] Failed to apply config change: ${(err as Error).message}`);
    }
  }

  // interactive:false = no-gesture path (tree render while the view becomes
  // visible, files.autoSave-driven remote-edit saves): the connect never
  // prompts and fails fast with a typed InteractionRequiredError, which the
  // callers turn into the "Host not verified" placeholder row or the
  // non-modal verification warning.
  async ensureConnected(options?: { interactive?: boolean }): Promise<void> {
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

    // Create the correct service type for this server
    this.sftp = createTransferService(server.type);

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
      agentSocketPath: credential.agentSocketPath,
      useSshConfig: credential.useSshConfig,
      jumpHosts: credential.jumpHosts,
      mappings: [],
      excludedPaths: [],
    };

    // Host-key verification and keyboard-interactive prompts are not wired
    // here: SftpService.connect() applies the registered connect providers
    // (src/ssh/connectProviders.ts) to every SSH connect, and FTP/FTPS have
    // no host keys to verify.
    await this.sftp.connect(serverConfig, {
      password: credential.password,
      passphrase: credential.passphrase,
    }, { interactive: options?.interactive !== false });

    this.currentServerId = server.id;
    this.currentCredentialId = server.credentialId;
    this.currentRootPath = server.rootPath;
    this.currentRouteKeys = await this.computeRouteKeys(credential.jumpHosts);
    this.output.appendLine(`[remote-browser] Connected to ${serverName} (${credential.host})`);
  }

  // Canonical pool keys for this session's hops, so pool evictions can be
  // matched against the route (Q34). Ids resolve through the credential list
  // — a dangling id simply contributes no key.
  private async computeRouteKeys(jumpHostIds: string[] | undefined): Promise<Set<string>> {
    const keys = new Set<string>();
    if (!jumpHostIds || jumpHostIds.length === 0) {
      return keys;
    }
    const all = await this.credentialManager.getAll();
    for (const hopId of jumpHostIds) {
      const hop = all.find(c => c.id === hopId);
      if (hop) {
        keys.add(JumpHostPool.keyFor({ username: hop.username, host: hop.host, port: hop.port }));
      }
    }
    return keys;
  }

  async listDirectory(remotePath: string): Promise<FileEntry[]> {
    await this.ensureConnected();
    this.resetIdleTimer();
    return this.sftp.listDirectoryDetailed(remotePath);
  }

  async resolveSymlinkTargets(
    entries: FileEntry[],
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

  async downloadFile(remotePath: string, options?: { interactive?: boolean }): Promise<Buffer> {
    await this.ensureConnected(options);
    this.resetIdleTimer();
    return this.sftp.get(remotePath);
  }

  async uploadFile(localPath: string, remotePath: string, options?: { interactive?: boolean }): Promise<void> {
    await this.ensureConnected(options);
    this.resetIdleTimer();
    await this.sftp.uploadFile(localPath, remotePath);
  }

  async statRemote(remotePath: string, options?: { interactive?: boolean }): Promise<{ mtime: Date } | null> {
    await this.ensureConnected(options);
    this.resetIdleTimer();
    return this.sftp.stat(remotePath);
  }

  // Deliberately non-recursive intent: the caller pre-checks the parent, so a
  // missing parent should surface as an error. On FTP the transport cannot
  // enforce this (see the caveat at FtpService.mkdir).
  async createDirectory(remotePath: string): Promise<void> {
    await this.ensureConnected();
    this.resetIdleTimer();
    await this.sftp.mkdir(remotePath);
  }

  async exists(remotePath: string): Promise<boolean> {
    await this.ensureConnected();
    this.resetIdleTimer();
    return this.sftp.exists(remotePath);
  }

  // What sits at this path — 'd', '-', or null when nothing does. One call
  // where exists() would still leave the caller asking "file or folder?" —
  // the collision pre-checks (rename, and later duplicate/move) branch on it.
  async statRemoteType(remotePath: string): Promise<'d' | '-' | null> {
    await this.ensureConnected();
    this.resetIdleTimer();
    return this.sftp.statType(remotePath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.ensureConnected();
    this.resetIdleTimer();
    await this.sftp.rename(oldPath, newPath);
  }

  async chmod(remotePath: string, mode: number): Promise<void> {
    await this.ensureConnected();
    this.resetIdleTimer();
    await this.sftp.chmod(remotePath, mode);
  }

  getCurrentServerId(): string | null {
    return this.currentServerId;
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
    this.currentCredentialId = null;
    this.currentRouteKeys = new Set();
  }

  getRootPath(): string {
    return this.currentRootPath;
  }

  dispose(): void {
    this.clearIdleTimer();
    this.configSaveSubscription.dispose();
    this.credentialChangeSubscription.dispose();
    this.poolEvictSubscription?.dispose();
    this._onDidDisconnect.dispose();
    this._onDidLoseRoute.dispose();
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
