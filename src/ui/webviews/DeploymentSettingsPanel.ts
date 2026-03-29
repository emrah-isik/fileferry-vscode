import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CredentialManager } from '../../storage/CredentialManager';
import { ServerManager } from '../../storage/ServerManager';
import { ProjectBindingManager } from '../../storage/ProjectBindingManager';
import { SftpService } from '../../sftpService';
import { generateId } from '../../utils/uuid';
import { DeploymentServer } from '../../models/DeploymentServer';
import { ServerBinding } from '../../models/ProjectBinding';
import { validateDeploymentServer, validateMappings } from '../../utils/validation';

interface Deps {
  credentialManager: CredentialManager;
  serverManager: ServerManager;
  bindingManager: ProjectBindingManager;
  credentialsChanged?: vscode.Event<void>;
}

export class DeploymentSettingsPanel {
  private static currentPanel: DeploymentSettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(context: vscode.ExtensionContext, deps: Deps): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DeploymentSettingsPanel.currentPanel) {
      DeploymentSettingsPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'fileferrySettings',
      'FileFerry: Deployment Settings',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'deployment-settings'),
        ],
        retainContextWhenHidden: true,
      }
    );

    DeploymentSettingsPanel.currentPanel = new DeploymentSettingsPanel(panel, context, deps);
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

    if (deps.credentialsChanged) {
      deps.credentialsChanged(() => this.pushUpdatedCredentials(), null, this.disposables);
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.command) {
      case 'ready':
        await this.sendInitialState();
        break;

      case 'saveServer':
        await this.handleSaveServer(msg.payload);
        break;

      case 'deleteServer': {
        const serverToDelete = await this.deps.serverManager.getServer(msg.id);
        const answer = await vscode.window.showWarningMessage(
          `Delete server "${serverToDelete?.name ?? 'this server'}"? This cannot be undone.`,
          'Delete', 'Cancel'
        );
        if (answer !== 'Delete') break;
        await this.deps.serverManager.delete(msg.id);
        this.panel.webview.postMessage({ command: 'serverDeleted', id: msg.id });
        break;
      }

      case 'setDefaultServer':
        await this.deps.bindingManager.setDefaultServer(msg.id);
        const updatedBinding = await this.deps.bindingManager.getBinding();
        this.panel.webview.postMessage({ command: 'bindingUpdated', binding: updatedBinding });
        break;

      case 'saveMapping': {
        const mappingErrors = validateMappings(
          msg.serverBinding.mappings,
          msg.serverBinding.excludedPaths
        );
        if (mappingErrors.length > 0) {
          const errors = Object.fromEntries(mappingErrors.map((e: { field: string; message: string }) => [e.field, e.message]));
          this.panel.webview.postMessage({ command: 'validationError', errors });
          break;
        }
        // Preserve rootPathOverride — it's managed by a separate form section
        const existingForMerge = await this.deps.bindingManager.getBinding();
        const mergedBinding: ServerBinding = {
          ...msg.serverBinding,
          rootPathOverride: existingForMerge?.servers[msg.serverId]?.rootPathOverride,
        };
        await this.deps.bindingManager.setServerBinding(msg.serverId, mergedBinding);
        this.panel.webview.postMessage({ command: 'mappingSaved', serverId: msg.serverId, serverBinding: mergedBinding });
        const mappingServer = await this.deps.serverManager.getServer(msg.serverId);
        vscode.window.showInformationMessage(`FileFerry: Mappings saved for "${mappingServer?.name ?? msg.serverId}".`);
        break;
      }

      case 'deleteMapping':
        await this.handleDeleteMapping(msg.serverId, msg.index);
        break;

      case 'testConnection':
        await this.handleTestConnection(msg.serverId);
        break;

      case 'cloneServer': {
        const original = await this.deps.serverManager.getServer(msg.id);
        if (!original) break;
        const allServers = await this.deps.serverManager.getAll();
        let cloneName = `${original.name} (copy)`;
        if (allServers.some(s => s.name.toLowerCase() === cloneName.toLowerCase())) {
          cloneName = `${original.name} (copy ${Date.now()})`;
        }
        const clone: DeploymentServer = { ...original, id: generateId(), name: cloneName };
        await this.deps.serverManager.save(clone);
        this.panel.webview.postMessage({ command: 'serverSaved', server: clone });
        break;
      }

      case 'saveRootPathOverride': {
        const override = (msg.rootPathOverride as string | undefined)?.trim() || undefined;
        if (override && !override.startsWith('/')) {
          this.panel.webview.postMessage({ command: 'validationError', errors: { rootPathOverride: 'Root path override must start with /' } });
          break;
        }
        const existingBinding = await this.deps.bindingManager.getBinding();
        const existingSb: ServerBinding = existingBinding?.servers[msg.serverId] ?? { mappings: [], excludedPaths: [] };
        const updatedSb: ServerBinding = { ...existingSb, rootPathOverride: override };
        await this.deps.bindingManager.setServerBinding(msg.serverId, updatedSb);
        this.panel.webview.postMessage({ command: 'rootPathOverrideSaved', serverId: msg.serverId, rootPathOverride: updatedSb.rootPathOverride });
        break;
      }

      case 'browseDirectory':
        await this.handleBrowseDirectory(msg.credentialId, msg.startPath ?? '/');
        break;

      case 'openCredentials':
        vscode.commands.executeCommand('fileferry.openCredentials');
        break;
    }
  }

  private async pushUpdatedCredentials(): Promise<void> {
    const credentials = await this.deps.credentialManager.getAll();
    this.panel.webview.postMessage({ command: 'credentialsUpdated', credentials });
  }

  private async sendInitialState(): Promise<void> {
    const [servers, credentials, binding] = await Promise.all([
      this.deps.serverManager.getAll(),
      this.deps.credentialManager.getAll(),
      this.deps.bindingManager.getBinding(),
    ]);
    this.panel.webview.postMessage({ command: 'init', servers, credentials, binding });
  }

  private async handleSaveServer(payload: Partial<DeploymentServer>): Promise<void> {
    const [existingServers, existingCredentials] = await Promise.all([
      this.deps.serverManager.getAll(),
      this.deps.credentialManager.getAll(),
    ]);
    const validationErrors = validateDeploymentServer(
      payload, existingServers, existingCredentials, payload.id || undefined
    );
    if (validationErrors.length > 0) {
      const errors = Object.fromEntries(validationErrors.map(e => [e.field, e.message]));
      this.panel.webview.postMessage({ command: 'validationError', errors });
      return;
    }

    const server: DeploymentServer = {
      id: payload.id || generateId(),
      name: payload.name!.trim(),
      type: payload.type ?? 'sftp',
      credentialId: payload.credentialId!,
      rootPath: payload.rootPath!.trim(),
    };

    try {
      await this.deps.serverManager.save(server);
      this.panel.webview.postMessage({ command: 'serverSaved', server });
      vscode.window.showInformationMessage(`FileFerry: Server "${server.name}" saved.`);
    } catch (err: unknown) {
      this.panel.webview.postMessage({
        command: 'validationError',
        errors: { credentialId: (err as Error).message },
      });
    }
  }

  private async handleDeleteMapping(serverId: string, index: number): Promise<void> {
    const binding = await this.deps.bindingManager.getBinding();
    if (!binding?.servers[serverId]) return;

    const serverBinding: ServerBinding = {
      ...binding.servers[serverId],
      mappings: binding.servers[serverId].mappings.filter((_, i) => i !== index),
    };

    await this.deps.bindingManager.setServerBinding(serverId, serverBinding);
    this.panel.webview.postMessage({ command: 'mappingSaved', serverId, serverBinding });
  }

  private async handleTestConnection(serverId: string): Promise<void> {
    const server = await this.deps.serverManager.getServer(serverId);
    if (!server) {
      this.panel.webview.postMessage({ command: 'testResult', success: false, message: 'Server not found' });
      return;
    }

    const existingCredentials = await this.deps.credentialManager.getAll();
    const validationErrors = validateDeploymentServer(server, [], existingCredentials, server.id);
    if (validationErrors.length > 0) {
      this.panel.webview.postMessage({ command: 'testResult', success: false, message: validationErrors[0].message });
      return;
    }

    const credential = await this.deps.credentialManager.getWithSecret(server.credentialId);
    const sftp = new SftpService();
    try {
      await sftp.connect(credential as any, { password: credential.password, passphrase: credential.passphrase });
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

  private buildHtml(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'deployment-settings', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'deployment-settings', 'style.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>FileFerry Settings</title>
</head>
<body>
  <div id="app">
    <div id="server-list-panel"></div>
    <div id="server-detail-panel">
      <div class="tabs">
        <button class="tab-btn active" data-tab="connection">Connection</button>
        <button class="tab-btn" data-tab="mappings">Mappings</button>
      </div>
      <div id="connection-tab" class="tab-content active"></div>
      <div id="mappings-tab" class="tab-content"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async handleBrowseDirectory(credentialId: string, startPath: string): Promise<void> {
    let credential;
    try {
      credential = await this.deps.credentialManager.getWithSecret(credentialId);
    } catch {
      this.panel.webview.postMessage({ command: 'browseError', message: 'Credential not found. Save the server first.' });
      return;
    }

    const sftp = new SftpService();
    try {
      await sftp.connect(credential as any, { password: credential.password, passphrase: credential.passphrase });
    } catch (err: unknown) {
      this.panel.webview.postMessage({ command: 'browseError', message: `Connection failed: ${(err as Error).message}` });
      return;
    }

    try {
      let currentPath = startPath || '/';
      if (currentPath !== '/' && currentPath.endsWith('/')) {
        currentPath = currentPath.slice(0, -1);
      }

      // Try the requested path; if it fails fall back to the user's home directory
      try {
        await sftp.listDirectory(currentPath);
      } catch {
        try {
          currentPath = await sftp.resolveRemotePath('.');
        } catch (err: unknown) {
          this.panel.webview.postMessage({ command: 'browseError', message: `Cannot access remote filesystem: ${(err as Error).message}` });
          return;
        }
      }

      while (true) {
        let items: Array<{ name: string; type: string }>;
        try {
          items = await sftp.listDirectory(currentPath);
        } catch (err: unknown) {
          this.panel.webview.postMessage({ command: 'browseError', message: `Could not list directory: ${(err as Error).message}` });
          break;
        }

        const dirs = items.filter(i => i.type === 'd').map(i => i.name).sort();
        const quickPickItems: vscode.QuickPickItem[] = [
          { label: '$(check) Select this folder', description: currentPath },
          ...(currentPath !== '/' ? [{ label: '$(arrow-up) ..', description: '(parent directory)' }] : []),
          ...dirs.map(d => ({ label: `$(folder) ${d}` })),
        ];

        const picked = await vscode.window.showQuickPick(quickPickItems, {
          title: `Browse: ${currentPath}`,
          placeHolder: 'Select a folder or navigate into a subdirectory',
        });

        if (!picked) {
          this.panel.webview.postMessage({ command: 'browseDone' });
          break;
        }

        if (picked.label.startsWith('$(check)')) {
          this.panel.webview.postMessage({ command: 'directorySelected', path: currentPath });
          break;
        } else if (picked.label.startsWith('$(arrow-up)')) {
          currentPath = path.posix.dirname(currentPath);
        } else {
          const folderName = picked.label.replace('$(folder) ', '');
          currentPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
        }
      }
    } finally {
      await sftp.disconnect();
    }
  }

  dispose(): void {
    DeploymentSettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }
}
