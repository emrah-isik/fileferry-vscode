import * as vscode from 'vscode';
import { ProjectServer } from '../models/ProjectConfig';
import { SshCredential } from '../models/SshCredential';

export interface ServerItemData {
  serverName: string;
  server: ProjectServer;
  credential: SshCredential | undefined;
  /**
   * Resolved credentials for `credential.jumpHosts`, in chain order (18a-2b).
   * `undefined` entries mark hops whose credential no longer exists. Absent
   * or empty for direct connections.
   */
  hopCredentials?: Array<SshCredential | undefined>;
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
      const stops = (data.hopCredentials ?? []).map(hop =>
        hop ? `${hop.username}@${hop.host}:${hop.port}` : '(missing jump host)'
      );
      stops.push(`${data.credential.username}@${data.credential.host}:${data.credential.port}`);
      this.tooltip = `Route: local → ${stops.join(' → ')}`;
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
