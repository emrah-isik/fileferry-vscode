import * as vscode from 'vscode';
import { ProjectBindingManager } from '../storage/ProjectBindingManager';
import { ServerManager } from '../storage/ServerManager';

interface MenuAction {
  label: string;
  id: string;
  description?: string;
}

export class StatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private uploadOnSave = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly bindingManager: ProjectBindingManager,
    private readonly serverManager: ServerManager
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'fileferry.statusBarMenu';
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
      this.uploadOnSave = false;
      this.item.text = '$(server) FileFerry';
      this.item.tooltip = 'FileFerry: Click to open Deployment Settings';
      this.item.show();
      return;
    }
    const server = await this.serverManager.getServer(binding.defaultServerId);
    const name = server?.name ?? 'FileFerry';
    this.uploadOnSave = binding.uploadOnSave === true;
    const icon = this.uploadOnSave ? '$(cloud-upload)' : '$(server)';
    this.item.text = `${icon} ${name}`;
    this.item.tooltip = `FileFerry: ${name} — Upload on save: ${this.uploadOnSave ? 'ON' : 'OFF'}`;
    this.item.show();
  }

  async showMenu(): Promise<void> {
    const items: MenuAction[] = [
      {
        label: '$(cloud-upload) Upload on Save',
        id: 'toggleUploadOnSave',
        description: this.uploadOnSave ? 'ON' : 'OFF',
      },
      {
        label: '$(server) Switch Server',
        id: 'switchServer',
      },
      {
        label: '$(gear) Deployment Settings',
        id: 'openSettings',
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'FileFerry',
    });

    if (!picked) {
      return;
    }

    const commandMap: Record<string, string> = {
      toggleUploadOnSave: 'fileferry.toggleUploadOnSave',
      switchServer: 'fileferry.switchServer',
      openSettings: 'fileferry.openSettings',
    };

    await vscode.commands.executeCommand(commandMap[picked.id]);
  }

  dispose(): void {
    this.item.dispose();
  }
}
