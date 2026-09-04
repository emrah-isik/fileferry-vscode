import * as vscode from 'vscode';
import { TransferService, FileEntry } from '../transferService';
import { createTransferService } from '../transferServiceFactory';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { toConnectTarget } from '../connectTarget';
import { JumpHostPool } from '../ssh/JumpHostPool';
import { ConnectionCancelledError } from '../ssh/connectErrors';
import { ProjectServer } from '../models/ProjectConfig';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// The one connect this shared connection currently has in flight (18a-2b §I
// wedge fix). Overlapping ensureConnected calls join it instead of racing it,
// and a default-server change / suspend / disconnect aborts it — including a
// connect parked on an open MFA prompt, which previously wedged every later
// panel render until Reload Window.
interface InFlightConnect {
  serverId: string;
  credentialId: string;
  interactive: boolean;
  promise: Promise<void>;
  controller: AbortController;
}

export class RemoteBrowserConnection {
  private sftp: TransferService;
  private currentServerId: string | null = null;
  private currentCredentialId: string | null = null;
  private currentRootPath: string = '/';
  private inFlightConnect: InFlightConnect | null = null;
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
      if (this.inFlightConnect?.credentialId === event.id) {
        // The in-flight dial authenticated with data that just changed.
        this.abortInFlightConnect('its credential changed');
      }
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
    try {
      const config = await this.configManager.getConfig();
      const match = config?.defaultServerId
        ? await this.configManager.getServerById(config.defaultServerId)
        : undefined;

      // §I wedge fix: a connect parked on an open prompt has no session yet
      // (`connected` is still false during the chain phase), so it must be
      // cancelled HERE — before the connected checks — when it no longer
      // matches the default. Otherwise its render promise never settles and
      // the panel hangs until Reload Window.
      const inFlight = this.inFlightConnect;
      if (inFlight && (!match
        || match.server.id !== inFlight.serverId
        || match.server.credentialId !== inFlight.credentialId)) {
        this.abortInFlightConnect('the default server changed');
      }

      if (!this.sftp.connected) { return; }
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
    const interactive = options?.interactive !== false;
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

    // Overlap guard (§I wedge fix): the panel's renders, saves, and commands
    // all share this connection — never run two connects at once.
    const inFlight = this.inFlightConnect;
    if (inFlight) {
      const sameIdentity = inFlight.serverId === server.id
        && inFlight.credentialId === server.credentialId;
      if (sameIdentity && (inFlight.interactive || !interactive)) {
        return inFlight.promise;
      }
      if (sameIdentity) {
        // Interactive request joining a background connect: take its result;
        // only if it fails (e.g. needing prompts) run our own attempt.
        try {
          await inFlight.promise;
          return;
        } catch {
          // fall through to a fresh interactive connect
        }
      } else {
        this.abortInFlightConnect('superseded by a connection to a different server');
      }
    }

    const controller = new AbortController();
    const entry: InFlightConnect = {
      serverId: server.id,
      credentialId: server.credentialId,
      interactive,
      promise: this.performConnect(serverName, server, interactive, controller.signal),
      controller,
    };
    this.inFlightConnect = entry;
    try {
      await entry.promise;
    } finally {
      if (this.inFlightConnect === entry) {
        this.inFlightConnect = null;
      }
    }
  }

  private async performConnect(
    serverName: string,
    server: ProjectServer,
    interactive: boolean,
    signal: AbortSignal
  ): Promise<void> {
    // Connected to a different server — disconnect first
    if (this.sftp.connected) {
      await this.sftp.disconnect();
    }

    // Create the correct service type for this server
    const service = createTransferService(server.type);
    this.sftp = service;

    const credential = await this.credentialManager.getWithSecret(server.credentialId);

    const target = toConnectTarget(credential, server.type);

    // Host-key verification and keyboard-interactive prompts are not wired
    // here: SftpService.connect() applies the registered connect providers
    // (src/ssh/connectProviders.ts) to every SSH connect, and FTP/FTPS have
    // no host keys to verify. The signal lets abortInFlightConnect cancel
    // this dial — an open prompt included.
    await service.connect(target, {
      password: credential.password,
      passphrase: credential.passphrase,
    }, { interactive, signal });

    if (signal.aborted) {
      // Aborted in the narrow window after the transport resolved — the
      // superseding connect owns the state now, so never adopt this session.
      await service.disconnect().catch(() => undefined);
      throw new ConnectionCancelledError('the connection request was superseded');
    }

    this.currentServerId = server.id;
    this.currentCredentialId = server.credentialId;
    this.currentRootPath = server.rootPath;
    // Q34: the service knows its real route — explicit hops or config-derived
    // ProxyJump hops alike (18b) — so evictions match what was actually dialed.
    this.currentRouteKeys = new Set(service.routeKeys ?? []);
    this.output.appendLine(`[remote-browser] Connected to ${serverName} (${credential.host})`);
  }

  // §I wedge fix: settles the in-flight connect's promise (rejecting through
  // SftpService's abort machinery) and dismisses any prompt it has open, so
  // a parked connect can never wedge later renders.
  private abortInFlightConnect(reason: string): void {
    const inFlight = this.inFlightConnect;
    if (!inFlight) {
      return;
    }
    this.inFlightConnect = null;
    this.output.appendLine(`[remote-browser] Cancelling in-flight connect — ${reason}`);
    inFlight.controller.abort();
    // The owner's await handles the rejection; this guard only covers the
    // window where the owner's frame was already torn down.
    inFlight.promise.catch(() => undefined);
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
    this.abortInFlightConnect('disconnected');
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
