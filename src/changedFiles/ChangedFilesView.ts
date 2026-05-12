import * as vscode from 'vscode';
import { ChangedFilesProvider } from './ChangedFilesProvider';
import { GitService } from '../gitService';

export class ChangedFilesView {
  private readonly provider: ChangedFilesProvider;
  private readonly treeView: vscode.TreeView<vscode.TreeItem>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(viewId: string, gitService: GitService) {
    this.provider = new ChangedFilesProvider(
      gitService,
      () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );

    this.treeView = vscode.window.createTreeView(viewId, {
      treeDataProvider: this.provider,
      canSelectMany: true,
      showCollapseAll: false,
    });

    // Auto-refresh on any git state change in any open repository.
    this.disposables.push(gitService.onRepositoryChange(() => this.provider.refresh()));
    this.disposables.push(this.treeView);
  }

  getSelection(): readonly vscode.TreeItem[] {
    return this.treeView.selection;
  }

  refresh(): void {
    this.provider.refresh();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
