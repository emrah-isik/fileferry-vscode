import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CredentialManager } from '../../storage/CredentialManager';
import { ProjectConfigManager } from '../../storage/ProjectConfigManager';
import { createTransferService } from '../../transferServiceFactory';
import { generateId } from '../../utils/uuid';
import { ProjectServer } from '../../models/ProjectConfig';
import { validateProjectServer, validateMappings } from '../../utils/validation';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  credentialsChanged?: vscode.Event<void>;
}

export class DeploymentSettingsPanel {
  private static currentPanel: DeploymentSettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(context: vscode.ExtensionContext, dependencies: Dependencies): void {
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

    DeploymentSettingsPanel.currentPanel = new DeploymentSettingsPanel(panel, context, dependencies);
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

    if (dependencies.credentialsChanged) {
      dependencies.credentialsChanged(() => this.pushUpdatedCredentials(), null, this.disposables);
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
        const found = await this.dependencies.configManager.getServerById(msg.id);
        const answer = await vscode.window.showWarningMessage(
          `Delete server "${found?.name ?? 'this server'}"? This cannot be undone.`,
          'Delete', 'Cancel'
        );
        if (answer !== 'Delete') break;
        await this.dependencies.configManager.removeServer(found!.name);
        const configAfterDelete = await this.dependencies.configManager.getConfig();
        this.panel.webview.postMessage({ command: 'configUpdated', config: configAfterDelete });
        break;
      }

      case 'setDefaultServer':
        await this.dependencies.configManager.setDefaultServer(msg.id);
        const configAfterDefault = await this.dependencies.configManager.getConfig();
        this.panel.webview.postMessage({ command: 'configUpdated', config: configAfterDefault });
        break;

      case 'saveMapping': {
        const entry = await this.dependencies.configManager.getServerById(msg.serverId);
        if (!entry) break;
        const mappingErrors = validateMappings(msg.mappings, msg.excludedPaths);
        if (mappingErrors.length > 0) {
          const errors = Object.fromEntries(mappingErrors.map((e: { field: string; message: string }) => [e.field, e.message]));
          this.panel.webview.postMessage({ command: 'validationError', errors });
          break;
        }
        const config = await this.dependencies.configManager.getConfig();
        if (!config) break;
        config.servers[entry.name] = {
          ...entry.server,
          mappings: msg.mappings,
          excludedPaths: msg.excludedPaths,
        };
        await this.dependencies.configManager.saveConfig(config);
        this.panel.webview.postMessage({ command: 'configUpdated', config });
        vscode.window.showInformationMessage(`FileFerry: Mappings saved for "${entry.name}".`);
        break;
      }

      case 'deleteMapping':
        await this.handleDeleteMapping(msg.serverId, msg.index);
        break;

      case 'testConnection':
        await this.handleTestConnection(msg.serverId);
        break;

      case 'cloneServer': {
        const original = await this.dependencies.configManager.getServerById(msg.id);
        if (!original) break;
        const config = await this.dependencies.configManager.getConfig();
        if (!config) break;
        let cloneName = `${original.name} (copy)`;
        if (config.servers[cloneName]) {
          cloneName = `${original.name} (copy ${Date.now()})`;
        }
        const clone: ProjectServer = { ...original.server, id: generateId() };
        config.servers[cloneName] = clone;
        await this.dependencies.configManager.saveConfig(config);
        this.panel.webview.postMessage({ command: 'configUpdated', config });
        break;
      }

      case 'browseDirectory':
        await this.handleBrowseDirectory(msg.credentialId, msg.startPath ?? '/', msg.serverType);
        break;

      case 'openCredentials':
        vscode.commands.executeCommand('fileferry.openCredentials');
        break;
    }
  }

  private async pushUpdatedCredentials(): Promise<void> {
    const credentials = await this.dependencies.credentialManager.getAll();
    this.panel.webview.postMessage({ command: 'credentialsUpdated', credentials });
  }

  private async sendInitialState(): Promise<void> {
    const [config, credentials] = await Promise.all([
      this.dependencies.configManager.getConfig(),
      this.dependencies.credentialManager.getAll(),
    ]);
    this.panel.webview.postMessage({ command: 'init', config, credentials });
  }

  private async handleSaveServer(payload: any): Promise<void> {
    const existingCredentials = await this.dependencies.credentialManager.getAll();
    const config = (await this.dependencies.configManager.getConfig()) ?? { defaultServerId: '', servers: {} };
    const existingServerNames = Object.keys(config.servers);

    // When editing, find the current name so uniqueness check excludes self
    let currentName: string | undefined;
    if (payload.id) {
      for (const [name, server] of Object.entries(config.servers)) {
        if (server.id === payload.id) {
          currentName = name;
          break;
        }
      }
    }

    const validationErrors = validateProjectServer(
      payload.name ?? '',
      payload,
      existingServerNames,
      existingCredentials,
      currentName
    );
    if (validationErrors.length > 0) {
      const errors = Object.fromEntries(validationErrors.map(e => [e.field, e.message]));
      this.panel.webview.postMessage({ command: 'validationError', errors });
      return;
    }

    const trimmedName = (payload.name as string).trim();

    // Look up credentialName from credential
    const credentialName = existingCredentials.find(c => c.id === payload.credentialId)?.name ?? '';

    // Build the ProjectServer
    const existing = currentName ? config.servers[currentName] : undefined;
    const server: ProjectServer = {
      id: payload.id || generateId(),
      type: payload.type ?? 'sftp',
      credentialId: payload.credentialId!,
      credentialName,
      rootPath: (payload.rootPath as string).trim(),
      mappings: existing?.mappings ?? [],
      excludedPaths: existing?.excludedPaths ?? [],
      ...(payload.filePermissions !== undefined ? { filePermissions: payload.filePermissions } : {}),
      ...(payload.directoryPermissions !== undefined ? { directoryPermissions: payload.directoryPermissions } : {}),
    };

    // If renaming, remove old key
    if (currentName && currentName !== trimmedName) {
      delete config.servers[currentName];
    }

    config.servers[trimmedName] = server;
    await this.dependencies.configManager.saveConfig(config);
    this.panel.webview.postMessage({ command: 'configUpdated', config });
    vscode.window.showInformationMessage(`FileFerry: Server "${trimmedName}" saved.`);
  }

  private async handleDeleteMapping(serverId: string, index: number): Promise<void> {
    const entry = await this.dependencies.configManager.getServerById(serverId);
    if (!entry) return;
    const config = await this.dependencies.configManager.getConfig();
    if (!config) return;

    config.servers[entry.name] = {
      ...entry.server,
      mappings: entry.server.mappings.filter((_, i) => i !== index),
    };

    await this.dependencies.configManager.saveConfig(config);
    this.panel.webview.postMessage({ command: 'configUpdated', config });
  }

  private async handleTestConnection(serverId: string): Promise<void> {
    const entry = await this.dependencies.configManager.getServerById(serverId);
    if (!entry) {
      this.panel.webview.postMessage({ command: 'testResult', success: false, message: 'Server not found' });
      return;
    }

    const existingCredentials = await this.dependencies.credentialManager.getAll();
    const validationErrors = validateProjectServer(
      entry.name, entry.server, [], existingCredentials, entry.name
    );
    if (validationErrors.length > 0) {
      this.panel.webview.postMessage({ command: 'testResult', success: false, message: validationErrors[0].message });
      return;
    }

    const credential = await this.dependencies.credentialManager.getWithSecret(entry.server.credentialId);

    // FTP/FTPS only supports password authentication
    const isFtp = entry.server.type !== 'sftp';
    if (isFtp && credential.authMethod !== 'password') {
      this.panel.webview.postMessage({
        command: 'testResult',
        success: false,
        message: 'FTP/FTPS only supports password authentication. Change the credential auth method to "Password".',
      });
      return;
    }

    const service = createTransferService(entry.server.type);
    try {
      await service.connect(credential as any, { password: credential.password, passphrase: credential.passphrase });
      await service.disconnect();
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

  private async handleBrowseDirectory(credentialId: string, startPath: string, serverType?: string): Promise<void> {
    let credential;
    try {
      credential = await this.dependencies.credentialManager.getWithSecret(credentialId);
    } catch {
      this.panel.webview.postMessage({ command: 'browseError', message: 'Credential not found. Save the server first.' });
      return;
    }

    const sftp = createTransferService((serverType as any) ?? 'sftp');
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

        // Resolve symlinks to find which ones point to directories
        const symlinks = items.filter(i => i.type === 'l');
        const symlinkDirs: string[] = [];
        await Promise.all(symlinks.map(async (s) => {
          const fullPath = currentPath === '/' ? `/${s.name}` : `${currentPath}/${s.name}`;
          const target = await sftp.statType(fullPath);
          if (target === 'd') { symlinkDirs.push(s.name); }
        }));

        const dirs = [
          ...items.filter(i => i.type === 'd').map(i => i.name),
          ...symlinkDirs,
        ].sort();
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
