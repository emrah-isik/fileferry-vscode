import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { ProjectConfigManager } from '../../storage/ProjectConfigManager';

interface Dependencies {
  configManager: ProjectConfigManager;
}

export class ProjectSettingsPanel {
  private static currentPanel: ProjectSettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(context: vscode.ExtensionContext, dependencies: Dependencies): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ProjectSettingsPanel.currentPanel) {
      ProjectSettingsPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'fileferryProjectSettings',
      'FileFerry: Project Settings',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'project-settings'),
        ],
        retainContextWhenHidden: true,
      }
    );

    ProjectSettingsPanel.currentPanel = new ProjectSettingsPanel(panel, context, dependencies);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly dependencies: Dependencies
  ) {
    this.panel = panel;
    this.panel.webview.html = this.buildHtml(context);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.command) {
      case 'ready':
        await this.sendInitialState();
        break;

      case 'toggleUploadOnSave':
        await this.dependencies.configManager.toggleUploadOnSave();
        await this.pushConfigUpdate();
        break;

      case 'toggleFileDateGuard':
        await this.dependencies.configManager.toggleFileDateGuard();
        await this.pushConfigUpdate();
        break;

      case 'toggleBackupBeforeOverwrite':
        await this.dependencies.configManager.toggleBackupBeforeOverwrite();
        await this.pushConfigUpdate();
        break;

      case 'setBackupRetentionDays':
        await this.dependencies.configManager.setBackupRetentionDays(msg.value);
        await this.pushConfigUpdate();
        break;

      case 'setBackupMaxSizeMB':
        await this.dependencies.configManager.setBackupMaxSizeMB(msg.value);
        await this.pushConfigUpdate();
        break;
    }
  }

  private async sendInitialState(): Promise<void> {
    const config = await this.dependencies.configManager.getConfig();
    this.panel.webview.postMessage({ command: 'init', config });
  }

  private async pushConfigUpdate(): Promise<void> {
    const config = await this.dependencies.configManager.getConfig();
    this.panel.webview.postMessage({ command: 'configUpdated', config });
  }

  private buildHtml(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'project-settings', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'project-settings', 'style.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>FileFerry Project Settings</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    ProjectSettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }
}
