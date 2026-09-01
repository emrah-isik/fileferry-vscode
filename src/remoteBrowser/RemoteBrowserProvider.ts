import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteFileItem, RemoteEntry } from './RemoteFileItem';
import { RemoteBrowserConnection } from './RemoteBrowserConnection';
import { FileEntry } from '../transferService';
import { InteractionRequiredError } from '../ssh/connectErrors';

export class RemoteBrowserProvider implements vscode.TreeDataProvider<RemoteFileItem> {
  private userNavigatedPath: string | null = null;
  // Set by an explicit "Disconnect Remote Browser". While suspended the panel
  // shows a Disconnected placeholder instead of auto-reconnecting — only an
  // explicit user action (refresh command, Go to Remote Path, set default
  // server) clears it. The connection's own idle-timeout disconnect never
  // sets this, so idle sessions still reconnect transparently.
  private suspended = false;
  // The path the panel's ROOT currently shows — the last successful root
  // listing. Null before the first listing and after a failed one, so callers
  // (the "…in Current Path" create commands) can tell "not connected yet"
  // apart from a real location.
  private currentPath: string | null = null;
  // Set by resume()/navigateTo() — the gestures that request a render — and
  // consumed by the next root render. A root render without it (the view
  // becoming visible, background refreshes) is a background connect: it must
  // never prompt (18a-1b), and an unverified host shows the "Host not
  // verified" placeholder instead.
  private interactiveRenderPending = false;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RemoteFileItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangePath = new vscode.EventEmitter<string>();
  readonly onDidChangePath = this._onDidChangePath.event;

  constructor(private readonly connection: RemoteBrowserConnection) {}

  getTreeItem(element: RemoteFileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteFileItem): Promise<RemoteFileItem[]> {
    if (this.suspended) {
      if (element) {
        return [];
      }
      this.currentPath = null;
      this._onDidChangePath.fire('');
      return [this.createDisconnectedItem()];
    }

    // Only directories (and symlinks to directories) have children
    if (element) {
      const isExpandable = element.entry.type === 'd' ||
        (element.entry.type === 'l' && element.entry.symlinkTarget === 'd');
      if (!isExpandable) { return []; }
    }

    try {
      let targetPath: string;
      if (element) {
        // Expanding a folder is itself a click; if the session lapsed, the
        // reconnect inside listDirectory may prompt (default interactive).
        targetPath = element.entry.remotePath;
      } else {
        // Every root render connects here with an explicit interactivity —
        // also when a navigated path is set, so a later background render
        // (view becomes visible after an idle disconnect) cannot ride
        // listDirectory's interactive default into an unwanted prompt.
        const interactive = this.interactiveRenderPending;
        this.interactiveRenderPending = false;
        await this.connection.ensureConnected({ interactive });
        targetPath = this.userNavigatedPath ?? this.connection.getRootPath();
      }

      const entries = await this.connection.listDirectory(targetPath);
      if (!element) {
        this.currentPath = targetPath;
        this._onDidChangePath.fire(targetPath);
      }
      return await this.toTreeItems(entries, targetPath);
    } catch (err: unknown) {
      if (!element) {
        this.currentPath = null;
        this._onDidChangePath.fire('');
        if (err instanceof InteractionRequiredError) {
          return [this.createNotVerifiedItem()];
        }
      }
      return [this.createErrorItem(err)];
    }
  }

  getCurrentPath(): string | null {
    return this.currentPath;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async suspend(): Promise<void> {
    this.suspended = true;
    await this.connection.disconnect();
    this.refresh();
  }

  resume(): void {
    this.suspended = false;
    this.interactiveRenderPending = true;
    this.refresh();
  }

  navigateTo(remotePath: string): void {
    this.suspended = false;
    this.interactiveRenderPending = true;
    this.userNavigatedPath = remotePath;
    this.refresh();
  }

  private async toTreeItems(
    entries: FileEntry[],
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
        ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
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

  // Same placeholder pattern as createErrorItem: empty remotePath marks it as
  // not a real entry, so multi-target commands filter it out.
  private createDisconnectedItem(): RemoteFileItem {
    const disconnectedEntry: RemoteEntry = {
      name: 'Disconnected',
      type: '-',
      size: 0,
      modifyTime: 0,
      remotePath: '',
    };

    const item = new RemoteFileItem(disconnectedEntry);
    // Not 'remoteFile' (the constructor's default for type '-'): that would
    // match every file-scoped context-menu clause on a row that isn't a file.
    item.contextValue = 'remotePlaceholder';
    item.description = 'Click to reconnect';
    item.iconPath = new vscode.ThemeIcon('debug-disconnect');
    item.command = { command: 'fileferry.remoteBrowser.refresh', title: 'Reconnect' };
    return item;
  }

  // Shown when a background render was refused because the host is not yet
  // trusted (or verification would need prompts). A click IS a gesture: the
  // refresh command goes through resume(), which marks the next render
  // interactive, so clicking this row raises the verification prompts.
  private createNotVerifiedItem(): RemoteFileItem {
    const notVerifiedEntry: RemoteEntry = {
      name: 'Host not verified',
      type: '-',
      size: 0,
      modifyTime: 0,
      remotePath: '', // not a real entry — multi-target commands filter it
    };

    const item = new RemoteFileItem(notVerifiedEntry);
    item.contextValue = 'remotePlaceholder'; // same reasoning as the Disconnected row
    item.description = 'Click to connect';
    item.iconPath = new vscode.ThemeIcon('shield');
    item.command = { command: 'fileferry.remoteBrowser.refresh', title: 'Connect and verify' };
    return item;
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
    item.contextValue = 'remotePlaceholder'; // same reasoning as the Disconnected row
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
