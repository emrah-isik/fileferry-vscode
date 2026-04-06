import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectConfig, ProjectServer } from '../models/ProjectConfig';

export class ProjectConfigManager {
  private getConfigPath(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace open');
    }
    return path.join(folders[0].uri.fsPath, '.vscode', 'fileferry.json');
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
}
