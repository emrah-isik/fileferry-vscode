import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../gitService';
import { GitFile } from '../types';

export class ChangedFilesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly gitService: GitService,
    private readonly getWorkspaceRoot: () => string | undefined
  ) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return [this.makeEmptyPlaceholder()];
    }

    const files = this.gitService.getChangedFiles(workspaceRoot);
    if (files.length === 0) {
      return [this.makeEmptyPlaceholder()];
    }

    return files
      .slice()
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map(f => this.makeFileItem(f));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private makeFileItem(file: GitFile): vscode.TreeItem {
    const uri = vscode.Uri.file(file.absolutePath);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.label = path.basename(file.relativePath);
    item.description = path.dirname(file.relativePath).replace(/\\/g, '/');
    if (item.description === '.') {
      item.description = '';
    }
    item.resourceUri = uri;
    // Untracked files have no committed baseline, so git.openChange would fail —
    // open them directly instead, matching native SCM behavior.
    item.command = file.status === 'untracked'
      ? { command: 'vscode.open', title: 'Open File', arguments: [uri] }
      : { command: 'git.openChange', title: 'Open Changes', arguments: [uri] };
    return item;
  }

  private makeEmptyPlaceholder(): vscode.TreeItem {
    const item = new vscode.TreeItem('No changes', vscode.TreeItemCollapsibleState.None);
    return item;
  }
}
