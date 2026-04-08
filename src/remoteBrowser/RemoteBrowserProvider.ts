import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteFileItem, RemoteEntry } from './RemoteFileItem';
import { RemoteBrowserConnection } from './RemoteBrowserConnection';
import SftpClient from 'ssh2-sftp-client';

export class RemoteBrowserProvider implements vscode.TreeDataProvider<RemoteFileItem> {
  private userNavigatedPath: string | null = null;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RemoteFileItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangePath = new vscode.EventEmitter<string>();
  readonly onDidChangePath = this._onDidChangePath.event;

  constructor(private readonly connection: RemoteBrowserConnection) {}

  getTreeItem(element: RemoteFileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteFileItem): Promise<RemoteFileItem[]> {
    // Only directories (and symlinks to directories) have children
    if (element) {
      const isExpandable = element.entry.type === 'd' ||
        (element.entry.type === 'l' && element.entry.symlinkTarget === 'd');
      if (!isExpandable) { return []; }
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
      if (!element) { this._onDidChangePath.fire(targetPath); }
      return await this.toTreeItems(entries, targetPath);
    } catch (err: unknown) {
      if (!element) { this._onDidChangePath.fire(''); }
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

  private async toTreeItems(
    entries: SftpClient.FileInfo[],
    parentPath: string
  ): Promise<RemoteFileItem[]> {
    const symlinkTargets = await this.connection.resolveSymlinkTargets(entries, parentPath);

    const items = entries.map(entry => {
      const remoteEntry: RemoteEntry = {
        name: entry.name,
        type: entry.type as 'd' | '-' | 'l',
        size: entry.size,
        modifyTime: entry.modifyTime,
        remotePath: path.posix.join(parentPath, entry.name),
      };
      if (entry.type === 'l' && symlinkTargets.has(entry.name)) {
        remoteEntry.symlinkTarget = symlinkTargets.get(entry.name)!;
      }
      return new RemoteFileItem(remoteEntry);
    });

    // Sort: directories (and symlinked dirs) first, then alphabetical
    return items.sort((a, b) => {
      const aIsDir = (a.entry.type === 'd' || (a.entry.type === 'l' && a.entry.symlinkTarget === 'd')) ? 0 : 1;
      const bIsDir = (b.entry.type === 'd' || (b.entry.type === 'l' && b.entry.symlinkTarget === 'd')) ? 0 : 1;
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
    item.iconPath = new vscode.ThemeIcon('warning');

    if (/no server configured/i.test(message)) {
      item.command = { command: 'fileferry.openSettings', title: 'Open settings' };
    } else {
      item.command = { command: 'fileferry.remoteBrowser.refresh', title: 'Retry connection' };
    }

    return item;
  }
}
