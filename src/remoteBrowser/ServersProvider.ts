import * as vscode from 'vscode';
import { ServerItem, ServerItemData } from './ServerItem';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { CredentialManager } from '../storage/CredentialManager';

export class ServersProvider implements vscode.TreeDataProvider<ServerItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ServerItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly configManager: ProjectConfigManager,
    private readonly credentialManager: CredentialManager
  ) {}

  getTreeItem(element: ServerItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ServerItem[]> {
    const [config, credentials] = await Promise.all([
      this.configManager.getConfig(),
      this.credentialManager.getAll(),
    ]);

    if (!config) { return []; }

    const defaultServerId = config.defaultServerId ?? null;

    const items = Object.entries(config.servers).map(([name, server]) => {
      const credential = credentials.find(c => c.id === server.credentialId);
      const data: ServerItemData = {
        serverName: name,
        server,
        credential,
        isDefault: server.id === defaultServerId,
      };
      return new ServerItem(data);
    });

    // Sort: default first, then alphabetical by name
    return items.sort((a, b) => {
      if (a.data.isDefault !== b.data.isDefault) {
        return a.data.isDefault ? -1 : 1;
      }
      return a.data.serverName.localeCompare(b.data.serverName);
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
