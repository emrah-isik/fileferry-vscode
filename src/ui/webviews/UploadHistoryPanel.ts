import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { ProjectConfigManager } from '../../storage/ProjectConfigManager';
import { UploadHistoryService } from '../../services/UploadHistoryService';

interface Dependencies {
  configManager: ProjectConfigManager;
}

export class UploadHistoryPanel {
  private static currentPanel: UploadHistoryPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(context: vscode.ExtensionContext, dependencies: Dependencies): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (UploadHistoryPanel.currentPanel) {
      UploadHistoryPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'fileferryUploadHistory',
      'FileFerry: Upload History',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'upload-history'),
        ],
        retainContextWhenHidden: true,
      }
    );

    UploadHistoryPanel.currentPanel = new UploadHistoryPanel(panel, context, dependencies);
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

  private getHistoryService(): UploadHistoryService {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return new UploadHistoryService(workspaceRoot, 10000);
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.command) {
      case 'ready':
        await this.sendInitialState();
        break;

      case 'filter': {
        const service = this.getHistoryService();
        const entries = await service.getFiltered({
          serverId: msg.serverId,
          result: msg.result,
          search: msg.search,
        });
        this.panel.webview.postMessage({ command: 'filtered', entries });
        break;
      }

      case 'clear': {
        const service = this.getHistoryService();
        await service.clear();
        this.panel.webview.postMessage({ command: 'cleared' });
        break;
      }
    }
  }

  private async sendInitialState(): Promise<void> {
    const config = await this.dependencies.configManager.getConfig();
    const service = this.getHistoryService();
    const entries = await service.getAll();
    const servers = config
      ? Object.entries(config.servers).map(([name, s]) => ({ id: s.id, name }))
      : [];
    this.panel.webview.postMessage({ command: 'init', entries, servers });
  }

  private buildHtml(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'upload-history', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'upload-history', 'style.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>FileFerry Upload History</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    UploadHistoryPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }
}
