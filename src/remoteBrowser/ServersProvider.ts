import * as vscode from 'vscode';
import { ServerItem, ServerItemData } from './ServerItem';
import { ServerManager } from '../storage/ServerManager';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';

export class ServersProvider implements vscode.TreeDataProvider<ServerItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ServerItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly serverManager: ServerManager,
    private readonly credentialManager: CredentialManager,
    private readonly bindingManager: ProjectBindingManager
  ) {}

  getTreeItem(element: ServerItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ServerItem[]> {
    const [servers, credentials, binding] = await Promise.all([
      this.serverManager.getAll(),
      this.credentialManager.getAll(),
      this.bindingManager.getBinding(),
    ]);

    const defaultServerId = binding?.defaultServerId ?? null;

    const items = servers.map(server => {
      const credential = credentials.find(c => c.id === server.credentialId);
      const data: ServerItemData = {
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
      return a.data.server.name.localeCompare(b.data.server.name);
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
