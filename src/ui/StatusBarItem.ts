import * as vscode from 'vscode';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { resolveUploadOnSave } from '../services/uploadOnSaveResolution';

interface MenuAction {
  label: string;
  id: string;
  description?: string;
}

export class StatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private uploadOnSave = false;
  private uploadOnSaveSetOnServer = false;
  private dryRun = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly configManager: ProjectConfigManager
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
    const config = await this.configManager.getConfig();
    if (!config) {
      this.uploadOnSave = false;
      this.uploadOnSaveSetOnServer = false;
      this.dryRun = false;
      this.item.text = '$(server) FileFerry';
      this.item.tooltip = 'FileFerry: Click to open Deployment Settings';
      this.item.show();
      return;
    }
    const match = await this.configManager.getServerById(config.defaultServerId);
    const name = match?.name ?? 'FileFerry';
    // Effective state for the DEFAULT server (feature 35a): its own
    // uploadOnSave wins over the project toggle.
    const resolution = resolveUploadOnSave(config, match?.server);
    this.uploadOnSave = resolution.enabled;
    this.uploadOnSaveSetOnServer = resolution.source === 'server';
    this.dryRun = config.dryRun === true;

    if (this.dryRun) {
      this.item.text = `$(eye) ${name} — DRY RUN`;
      this.item.tooltip = `FileFerry: ${name} — Dry run mode ON (no files will be transferred)`;
    } else {
      const icon = this.uploadOnSave ? '$(cloud-upload)' : '$(server)';
      this.item.text = `${icon} ${name}`;
      this.item.tooltip = `FileFerry: ${name} — Upload on save: ${this.describeUploadOnSave()}`;
    }
    this.item.show();
  }

  private describeUploadOnSave(): string {
    const state = this.uploadOnSave ? 'ON' : 'OFF';
    return this.uploadOnSaveSetOnServer ? `${state} (set on this server)` : state;
  }

  async showMenu(): Promise<void> {
    const items: MenuAction[] = [
      {
        label: '$(eye) Dry Run Mode',
        id: 'toggleDryRun',
        description: this.dryRun ? 'ON' : 'OFF',
      },
      {
        label: '$(cloud-upload) Upload on Save',
        id: 'toggleUploadOnSave',
        description: this.describeUploadOnSave(),
      },
      {
        label: '$(sync) Sync to Remote',
        id: 'syncToRemote',
        description: 'mirror local tree',
      },
      {
        label: '$(server) Switch Server',
        id: 'switchServer',
      },
      {
        label: '$(gear) Deployment Settings',
        id: 'openSettings',
      },
      {
        label: '$(history) Upload History',
        id: 'showUploadHistory',
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'FileFerry',
    });

    if (!picked) {
      return;
    }

    const commandMap: Record<string, string> = {
      toggleDryRun: 'fileferry.toggleDryRun',
      toggleUploadOnSave: 'fileferry.toggleUploadOnSave',
      syncToRemote: 'fileferry.syncToRemote',
      switchServer: 'fileferry.switchServer',
      openSettings: 'fileferry.openSettings',
      showUploadHistory: 'fileferry.showUploadHistory',
    };

    await vscode.commands.executeCommand(commandMap[picked.id]);
  }

  dispose(): void {
    this.item.dispose();
  }
}
