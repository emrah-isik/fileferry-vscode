import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectConfig, ProjectServer } from '../models/ProjectConfig';
import { ensureGitignored } from '../utils/ensureGitignored';

// Shape of .vscode/fileferry.local.json. v1 only merges hooks, so it carries
// just the per-server hooks block — deliberately narrow to limit blast radius.
interface LocalProjectConfig {
  servers?: {
    [serverName: string]: { hooks?: ProjectServer['hooks'] };
  };
}

export class ProjectConfigManager {
  private readonly _onDidSaveConfig = new vscode.EventEmitter<void>();
  readonly onDidSaveConfig = this._onDidSaveConfig.event;

  private workspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace open');
    }
    return folders[0].uri.fsPath;
  }

  private getConfigPath(): string {
    return path.join(this.workspaceRoot(), '.vscode', 'fileferry.json');
  }

  // Git-ignored sibling of fileferry.json. Holds hook overrides a user doesn't
  // want committed (e.g. secret-bearing commands). Never written to the
  // committed file; merged in by getEffectiveConfig at read time.
  private getLocalConfigPath(): string {
    return path.join(this.workspaceRoot(), '.vscode', 'fileferry.local.json');
  }

  async getConfig(): Promise<ProjectConfig | null> {
    try {
      const raw = await fs.readFile(this.getConfigPath(), 'utf-8');
      return JSON.parse(raw) as ProjectConfig;
    } catch {
      return null;
    }
  }

  async getLocalConfig(): Promise<LocalProjectConfig | null> {
    try {
      const raw = await fs.readFile(this.getLocalConfigPath(), 'utf-8');
      return JSON.parse(raw) as LocalProjectConfig;
    } catch {
      return null;
    }
  }

  // The committed config with fileferry.local.json hook overrides merged in
  // (local wins, per server, hooks-only). This is what the deploy path reads so
  // local-only hooks take effect; the plain getConfig()/setters never see the
  // merge, so local hooks can't leak back into the committed file.
  async getEffectiveConfig(): Promise<ProjectConfig | null> {
    const base = await this.getConfig();
    if (!base) {
      return null;
    }
    const local = await this.getLocalConfig();
    if (!local?.servers) {
      return base;
    }
    for (const [serverName, localServer] of Object.entries(local.servers)) {
      const baseServer = base.servers[serverName];
      // Only servers that exist in the committed config get overridden, and
      // only their hooks — every other field stays as committed.
      if (baseServer && localServer && localServer.hooks !== undefined) {
        baseServer.hooks = localServer.hooks;
      }
    }
    return base;
  }

  async saveConfig(config: ProjectConfig): Promise<void> {
    const filePath = this.getConfigPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
    this._onDidSaveConfig.fire();
  }

  dispose(): void {
    this._onDidSaveConfig.dispose();
  }

  private emptyConfig(): ProjectConfig {
    return { defaultServerId: '', servers: {} };
  }

  async addServer(name: string, server: ProjectServer): Promise<void> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    if (config.servers[name]) {
      throw new Error(`Server name "${name}" already exists`);
    }
    config.servers[name] = server;
    await this.saveConfig(config);
  }

  async removeServer(name: string): Promise<void> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    const server = config.servers[name];
    delete config.servers[name];
    if (server && config.defaultServerId === server.id) {
      config.defaultServerId = '';
    }
    await this.saveConfig(config);
  }

  async renameServer(oldName: string, newName: string): Promise<void> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    if (!config.servers[oldName]) {
      throw new Error(`Server "${oldName}" not found`);
    }
    if (config.servers[newName]) {
      throw new Error(`Server name "${newName}" already exists`);
    }
    config.servers[newName] = config.servers[oldName];
    delete config.servers[oldName];
    await this.saveConfig(config);
  }

  async setDefaultServer(serverId: string): Promise<void> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    config.defaultServerId = serverId;
    await this.saveConfig(config);
  }

  async getServerById(id: string): Promise<{ name: string; server: ProjectServer } | undefined> {
    const config = await this.getConfig();
    if (!config) { return undefined; }
    for (const [name, server] of Object.entries(config.servers)) {
      if (server.id === id) {
        return { name, server };
      }
    }
    return undefined;
  }

  async getServer(name: string): Promise<ProjectServer | undefined> {
    const config = await this.getConfig();
    return config?.servers[name];
  }

  // The effective deploy hooks for a server — committed hooks with any
  // fileferry.local.json override merged in. This is what the deploy path and
  // the confirmation dialog read, so local-only hooks both run and are shown.
  async getServerHooks(serverName: string): Promise<ProjectServer['hooks'] | undefined> {
    const config = await this.getEffectiveConfig();
    return config?.servers[serverName]?.hooks;
  }

  async getServerNames(): Promise<string[]> {
    const config = await this.getConfig();
    return config ? Object.keys(config.servers) : [];
  }

  async toggleUploadOnSave(): Promise<boolean> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    config.uploadOnSave = !config.uploadOnSave;
    await this.saveConfig(config);
    return config.uploadOnSave;
  }

  async toggleFileDateGuard(): Promise<boolean> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    // fileDateGuard defaults to true when undefined, so toggling undefined → false
    config.fileDateGuard = config.fileDateGuard === false;
    await this.saveConfig(config);
    return config.fileDateGuard;
  }

  async toggleBackupBeforeOverwrite(): Promise<boolean> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    config.backupBeforeOverwrite = !config.backupBeforeOverwrite;
    await this.saveConfig(config);
    return config.backupBeforeOverwrite;
  }

  async toggleSyncBackupBeforeDelete(): Promise<boolean> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    // syncBackupBeforeDelete defaults to true when undefined, so toggling undefined → false
    config.syncBackupBeforeDelete = config.syncBackupBeforeDelete === false;
    await this.saveConfig(config);
    return config.syncBackupBeforeDelete;
  }

  async setBackupRetentionDays(days: number): Promise<void> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    config.backupRetentionDays = days;
    await this.saveConfig(config);
  }

  async setBackupMaxSizeMB(mb: number): Promise<void> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    config.backupMaxSizeMB = mb;
    await this.saveConfig(config);
  }

  async toggleDryRun(): Promise<boolean> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    config.dryRun = !config.dryRun;
    await this.saveConfig(config);
    return config.dryRun;
  }

  async toggleWatch(): Promise<boolean> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    const enabled = !config.watch?.enabled;
    config.watch = { enabled, patterns: config.watch?.patterns ?? [] };
    await this.saveConfig(config);
    return enabled;
  }

  async setWatchPatterns(patterns: string[]): Promise<void> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    config.watch = { enabled: config.watch?.enabled ?? false, patterns };
    await this.saveConfig(config);
  }

  // Sets a server's deploy hooks in the committed fileferry.json. Per-server
  // because "restart nginx on prod" is server-specific (see feature 27).
  async setServerHooks(serverName: string, hooks: ProjectServer['hooks']): Promise<void> {
    const config = (await this.getConfig()) ?? this.emptyConfig();
    const server = config.servers[serverName];
    if (!server) {
      throw new Error(`Server "${serverName}" not found`);
    }
    server.hooks = hooks;
    await this.saveConfig(config);
  }

  // Sets a server's hooks in the git-ignored fileferry.local.json — the escape
  // hatch for hooks a user does not want committed (e.g. secret-bearing
  // commands). Ensures the file is git-ignored on first write so it can't be
  // committed by accident.
  async setLocalServerHooks(serverName: string, hooks: ProjectServer['hooks']): Promise<void> {
    const local: LocalProjectConfig = (await this.getLocalConfig()) ?? {};
    local.servers = local.servers ?? {};
    local.servers[serverName] = { ...local.servers[serverName], hooks };

    const filePath = this.getLocalConfigPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(local, null, 2), 'utf-8');
    await ensureGitignored(this.workspaceRoot(), '.vscode/fileferry.local.json');
    this._onDidSaveConfig.fire();
  }
}
