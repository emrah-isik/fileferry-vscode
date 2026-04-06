import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { randomBytes } from 'crypto';
import { CredentialManager } from '../../storage/CredentialManager';
import { ProjectConfigManager } from '../../storage/ProjectConfigManager';
import { SftpService } from '../../sftpService';
import { generateId } from '../../utils/uuid';
import { SshCredential, SshCredentialWithSecret } from '../../models/SshCredential';
import { validateSshCredential } from '../../utils/validation';

interface Deps {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  onCredentialChange?: () => void;
}

export class SshCredentialPanel {
  private static currentPanel: SshCredentialPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(context: vscode.ExtensionContext, deps: Deps): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (SshCredentialPanel.currentPanel) {
      SshCredentialPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'fileferryCredentials',
      'FileFerry: SSH Credentials',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'ssh-credentials'),
        ],
        retainContextWhenHidden: true,
      }
    );

    SshCredentialPanel.currentPanel = new SshCredentialPanel(panel, context, deps);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly deps: Deps
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

      case 'saveCredential':
        await this.handleSaveCredential(msg.payload);
        break;

      case 'deleteCredential':
        await this.handleDeleteCredential(msg.id);
        break;

      case 'testConnection':
        await this.handleTestConnection(msg.credential, msg.password, msg.passphrase);
        break;

      case 'browsePrivateKey':
        await this.handleBrowsePrivateKey();
        break;

      case 'cloneCredential':
        await this.handleCloneCredential(msg.id);
        break;
    }
  }

  private async sendInitialState(): Promise<void> {
    // getAll() returns credentials without secret fields — passwords never go to the webview
    const credentials = await this.deps.credentialManager.getAll();
    this.panel.webview.postMessage({ command: 'init', credentials });
  }

  private async handleSaveCredential(payload: {
    credential: Partial<SshCredential>;
    password?: string;
    passphrase?: string;
  }): Promise<void> {
    const { credential, password, passphrase } = payload;

    const existing = await this.deps.credentialManager.getAll();
    const validationErrors = validateSshCredential(
      { ...credential, password },
      existing,
      credential.id || undefined
    );
    if (validationErrors.length > 0) {
      const errors = Object.fromEntries(validationErrors.map(e => [e.field, e.message]));
      this.panel.webview.postMessage({ command: 'validationError', errors });
      return;
    }

    const saved: SshCredential = {
      id: credential.id || generateId(),
      name: credential.name!.trim(),
      host: credential.host!.trim(),
      port: Number(credential.port) || 22,
      username: credential.username!.trim(),
      authMethod: credential.authMethod!,
      privateKeyPath: credential.privateKeyPath?.trim() || undefined,
    };

    // Empty string → undefined → CredentialManager.save() skips the keychain write
    await this.deps.credentialManager.save(saved, password || undefined, passphrase || undefined);

    // Check private key file permissions (informational only — does not block save)
    if (saved.authMethod === 'key' && saved.privateKeyPath) {
      try {
        const stats = await fs.stat(saved.privateKeyPath);
        const mode = stats.mode & 0o777;
        if (mode !== 0o600) {
          this.panel.webview.postMessage({
            command: 'warning',
            field: 'privateKeyPath',
            message: `Key file has permissions ${mode.toString(8)} — SSH requires 600. Run: chmod 600 ${saved.privateKeyPath}`,
          });
        }
      } catch {
        // File not accessible — will fail at connect time
      }
    }

    this.panel.webview.postMessage({ command: 'credentialSaved', credential: saved });
    vscode.window.showInformationMessage(`FileFerry: Credential "${saved.name}" saved.`);
    this.deps.onCredentialChange?.();
  }

  private async handleDeleteCredential(id: string): Promise<void> {
    const credentials = await this.deps.credentialManager.getAll();
    const credential = credentials.find(c => c.id === id);
    const config = await this.deps.configManager.getConfig();
    const references = config
      ? Object.entries(config.servers).filter(([, s]) => s.credentialId === id).map(([name]) => name)
      : [];

    const message = references.length > 0
      ? `Delete "${credential?.name ?? 'this credential'}"? It is used by: ${references.join(', ')}.`
      : `Delete "${credential?.name ?? 'this credential'}"? This cannot be undone.`;

    const answer = await vscode.window.showWarningMessage(message, 'Delete', 'Cancel');
    if (answer !== 'Delete') return;

    await this.deps.credentialManager.delete(id);
    this.panel.webview.postMessage({ command: 'credentialDeleted', id });
    this.deps.onCredentialChange?.();
  }

  private async handleTestConnection(
    credential: SshCredential,
    password?: string,
    passphrase?: string
  ): Promise<void> {
    let resolvedPassword = password || undefined;
    let resolvedPassphrase = passphrase || undefined;

    // If the form's secret fields are blank and this is an existing credential,
    // fetch the stored secrets from the keychain so the test can actually connect.
    if (credential.id && (resolvedPassword === undefined || resolvedPassphrase === undefined)) {
      try {
        const stored = await this.deps.credentialManager.getWithSecret(credential.id);
        if (resolvedPassword === undefined) resolvedPassword = stored.password;
        if (resolvedPassphrase === undefined) resolvedPassphrase = stored.passphrase;
      } catch {
        // Credential not yet saved — proceed with whatever was typed
      }
    }

    // Assemble a temporary credential with the resolved secrets — never persisted
    const tempCredential: SshCredentialWithSecret = {
      ...credential,
      password: resolvedPassword,
      passphrase: resolvedPassphrase,
    };

    const sftp = new SftpService();
    try {
      await sftp.connect(tempCredential as any, { password: tempCredential.password, passphrase: tempCredential.passphrase });
      await sftp.disconnect();
      this.panel.webview.postMessage({ command: 'testResult', success: true, message: 'Connected successfully' });
    } catch (err: unknown) {
      this.panel.webview.postMessage({
        command: 'testResult',
        success: false,
        message: (err as Error).message,
      });
    }
  }

  private async handleCloneCredential(id: string): Promise<void> {
    const original = await this.deps.credentialManager.getWithSecret(id);
    if (!original) { return; }
    const all = await this.deps.credentialManager.getAll();
    let cloneName = `${original.name} (copy)`;
    if (all.some(c => c.name.toLowerCase() === cloneName.toLowerCase())) {
      cloneName = `${original.name} (copy ${Date.now()})`;
    }
    const clone: SshCredential = {
      id: generateId(),
      name: cloneName,
      host: original.host,
      port: original.port,
      username: original.username,
      authMethod: original.authMethod,
      privateKeyPath: original.privateKeyPath,
      agentSocketPath: original.agentSocketPath,
    };
    await this.deps.credentialManager.save(clone, original.password, original.passphrase);
    await this.sendInitialState();
    this.panel.webview.postMessage({ command: 'credentialSaved', credential: clone });
  }

  private async handleBrowsePrivateKey(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: 'Select Private Key File',
      filters: { 'Key Files': ['pem', 'key', 'ppk'], 'All Files': ['*'] },
    });
    if (result && result.length > 0) {
      this.panel.webview.postMessage({
        command: 'privateKeySelected',
        path: result[0].fsPath,
      });
    }
  }

  private buildHtml(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'ssh-credentials', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'ssh-credentials', 'style.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>FileFerry: SSH Credentials</title>
</head>
<body>
  <div id="app">
    <div id="credential-list-panel"></div>
    <div id="credential-detail-panel"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    SshCredentialPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }
}
