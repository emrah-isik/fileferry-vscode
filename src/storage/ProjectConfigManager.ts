import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectConfig, ProjectServer } from '../models/ProjectConfig';

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

  async getConfig(): Promise<ProjectConfig | null> {
    try {
      const raw = await fs.readFile(this.getConfigPath(), 'utf-8');
      return JSON.parse(raw) as ProjectConfig;
    } catch {
      return null;
    }
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

  // The deploy hooks for a server, from the committed fileferry.json. Secrets
  // in commands are ${secret:NAME} keychain references, never values.
  async getServerHooks(serverName: string): Promise<ProjectServer['hooks'] | undefined> {
    const config = await this.getConfig();
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
}
