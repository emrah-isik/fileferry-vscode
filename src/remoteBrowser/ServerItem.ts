import * as vscode from 'vscode';
import { ProjectServer } from '../models/ProjectConfig';
import { SshCredential } from '../models/SshCredential';

export interface ServerItemData {
  serverName: string;
  server: ProjectServer;
  credential: SshCredential | undefined;
  /**
   * `local → hop… → target` for the tooltip (18a-2b), from `describeRoute`:
   * explicit jump hosts by credential (a deleted one as `(missing jump
   * host)`) or, for an `~/.ssh/config` alias, its ProxyJump chain (18b).
   */
  route?: string;
  isDefault: boolean;
}

export class ServerItem extends vscode.TreeItem {
  public readonly serverId: string;

  constructor(public readonly data: ServerItemData) {
    super(data.serverName, vscode.TreeItemCollapsibleState.None);

    this.serverId = data.server.id;

    if (data.isDefault) {
      this.iconPath = new vscode.ThemeIcon('circle-filled');
      this.contextValue = 'server-active';
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
      this.contextValue = 'server-inactive';
    }

    if (data.credential) {
      this.description = `${data.credential.username}@${data.credential.host}:${data.server.rootPath}`;
      // Route tooltip (18a-2b): every hop between local and the target, in
      // connect order — the tree row itself only shows the target.
      this.tooltip = `Route: ${data.route ?? `local → ${data.credential.username}@${data.credential.host}:${data.credential.port}`}`;
    } else {
      this.description = 'credential missing';
    }

    this.command = {
      command: 'fileferry.servers.setDefault',
      title: 'Set as Default',
      arguments: [data.server.id],
    };
  }
}
