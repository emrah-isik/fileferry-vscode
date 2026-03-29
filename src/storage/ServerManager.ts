import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DeploymentServer } from '../models/DeploymentServer';
import { CredentialManager } from './CredentialManager';

export class ServerManager {
  private readonly filePath: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly credentialManager: CredentialManager
  ) {
    this.filePath = path.join(context.globalStorageUri.fsPath, 'servers.json');
  }

  async getAll(): Promise<DeploymentServer[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as DeploymentServer[];
    } catch {
      return [];
    }
  }

  async save(server: DeploymentServer): Promise<void> {
    const credentials = await this.credentialManager.getAll();
    const credExists = credentials.some(c => c.id === server.credentialId);
    if (!credExists) {
      throw new Error(`Credential "${server.credentialId}" not found`);
    }

    const all = await this.getAll();
    const idx = all.findIndex(s => s.id === server.id);
    if (idx >= 0) {
      all[idx] = server;
    } else {
      all.push(server);
    }
    await this.writeFile(all);
  }

  async delete(id: string): Promise<void> {
    const all = await this.getAll();
    await this.writeFile(all.filter(s => s.id !== id));
  }

  async getServer(id: string): Promise<DeploymentServer | undefined> {
    const all = await this.getAll();
    return all.find(s => s.id === id);
  }

  private async writeFile(servers: DeploymentServer[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(servers, null, 2), 'utf-8');
  }
}
