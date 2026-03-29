import * as vscode from 'vscode';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';
import { ServerManager } from '../storage/ServerManager';

export class StatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(
    context: vscode.ExtensionContext,
    private readonly bindingManager: ProjectBindingManager,
    private readonly serverManager: ServerManager
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'fileferry.openSettings';
    this.item.tooltip = 'FileFerry: Click to open Deployment Settings';
    context.subscriptions.push(this.item);
    this.refresh();

    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.fileName.endsWith('fileferry.json')) {
          this.refresh();
        }
      })
    );
  }

  async refresh(): Promise<void> {
    const binding = await this.bindingManager.getBinding();
    if (!binding) {
      this.item.text = '$(cloud-upload) FileFerry';
      this.item.show();
      return;
    }
    const server = await this.serverManager.getServer(binding.defaultServerId);
    this.item.text = `$(cloud-upload) ${server?.name ?? 'FileFerry'}`;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
