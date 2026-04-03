import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteFileItem, RemoteEntry } from './RemoteFileItem';
import { RemoteBrowserConnection } from './RemoteBrowserConnection';
import SftpClient from 'ssh2-sftp-client';

export class RemoteBrowserProvider implements vscode.TreeDataProvider<RemoteFileItem> {
  private userNavigatedPath: string | null = null;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RemoteFileItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly connection: RemoteBrowserConnection) {}

  getTreeItem(element: RemoteFileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteFileItem): Promise<RemoteFileItem[]> {
    // File items have no children
    if (element && element.entry.type !== 'd') {
      return [];
    }

    try {
      let targetPath: string;
      if (element) {
        targetPath = element.entry.remotePath;
      } else if (this.userNavigatedPath) {
        targetPath = this.userNavigatedPath;
      } else {
        // Ensure connection is established so getRootPath() returns the
        // server's configured root instead of the pre-connection default '/'.
        await this.connection.ensureConnected();
        targetPath = this.connection.getRootPath();
      }

      const entries = await this.connection.listDirectory(targetPath);
      return this.toTreeItems(entries, targetPath);
    } catch (err: unknown) {
      return [this.createErrorItem(err)];
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  navigateTo(remotePath: string): void {
    this.userNavigatedPath = remotePath;
    this.refresh();
  }

  private toTreeItems(entries: SftpClient.FileInfo[], parentPath: string): RemoteFileItem[] {
    const items = entries.map(entry => {
      const remoteEntry: RemoteEntry = {
        name: entry.name,
        type: entry.type as 'd' | '-' | 'l',
        size: entry.size,
        modifyTime: entry.modifyTime,
        remotePath: path.posix.join(parentPath, entry.name),
      };
      return new RemoteFileItem(remoteEntry);
    });

    // Sort: directories first, then alphabetical within each group
    return items.sort((a, b) => {
      const aIsDir = a.entry.type === 'd' ? 0 : 1;
      const bIsDir = b.entry.type === 'd' ? 0 : 1;
      if (aIsDir !== bIsDir) { return aIsDir - bIsDir; }
      return a.entry.name.localeCompare(b.entry.name);
    });
  }

  private createErrorItem(err: unknown): RemoteFileItem {
    const message = err instanceof Error ? err.message : String(err);
    let label: string;

    if (/no server configured/i.test(message)) {
      label = 'No server configured';
    } else if (/permission denied/i.test(message)) {
      label = 'Permission denied';
    } else {
      label = 'Connection failed';
    }

    // Create a minimal RemoteEntry for the error placeholder
    const errorEntry: RemoteEntry = {
      name: label,
      type: '-',
      size: 0,
      modifyTime: 0,
      remotePath: '',
    };

    const item = new RemoteFileItem(errorEntry);
    item.description = message;
    item.command = undefined; // Remove the open-file command
    item.iconPath = new vscode.ThemeIcon('warning');
    return item;
  }
}
