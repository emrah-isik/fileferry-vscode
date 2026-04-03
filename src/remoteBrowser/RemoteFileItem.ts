import * as vscode from 'vscode';

export interface RemoteEntry {
  name: string;
  type: 'd' | '-' | 'l';
  size: number;
  modifyTime: number;
  remotePath: string;
}

export function formatSize(bytes: number): string {
  if (bytes === 0) { return '0 B'; }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i === 0) { return `${bytes} B`; }
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function formatDate(timestamp: number): string {
  if (!timestamp) { return ''; }
  const d = new Date(timestamp);
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  return `${month} ${day}`;
}

export class RemoteFileItem extends vscode.TreeItem {
  constructor(public readonly entry: RemoteEntry) {
    const isDir = entry.type === 'd';
    super(
      entry.name,
      isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // Use resourceUri so VS Code's file icon theme picks the icon
    // based on file name/extension (e.g. .ts, .log, .json get distinct icons).
    // Symlinks get a manual ThemeIcon since there's no theme equivalent.
    if (isDir) {
      this.contextValue = 'remoteDirectory';
      this.resourceUri = vscode.Uri.file(entry.remotePath);
    } else if (entry.type === 'l') {
      this.contextValue = 'remoteFile';
      this.iconPath = new vscode.ThemeIcon('file-symlink-file');
      this.command = {
        command: 'fileferry.remoteBrowser.openFile',
        title: 'Open Remote File',
        arguments: [entry],
      };
    } else {
      this.contextValue = 'remoteFile';
      this.resourceUri = vscode.Uri.file(entry.remotePath);
      this.command = {
        command: 'fileferry.remoteBrowser.openFile',
        title: 'Open Remote File',
        arguments: [entry],
      };
    }

    const parts: string[] = [];
    if (!isDir) { parts.push(formatSize(entry.size)); }
    const date = formatDate(entry.modifyTime);
    if (date) { parts.push(date); }
    if (parts.length > 0) {
      this.description = parts.join(', ');
    }
  }
}
