import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CredentialManager } from '../../storage/CredentialManager';
import { ProjectConfigManager } from '../../storage/ProjectConfigManager';
import { createTransferService } from '../../transferServiceFactory';
import { generateId } from '../../utils/uuid';
import { ProjectServer, HookCommand } from '../../models/ProjectConfig';
import { ServerType } from '../../types';
import { validateProjectServer, validateMappings } from '../../utils/validation';
import { TimeOffsetDetector } from '../../services/TimeOffsetDetector';
import { detectSecret, findSecretLiteral } from '../../utils/detectSecret';
import { HookSecretManager } from '../../storage/HookSecretManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
  credentialsChanged?: vscode.Event<void>;
  // Keychain-backed ${secret:NAME} store for hook commands (#27b). Absent when
  // no workspace folder is open — the secrets UI then reports an error.
  hookSecretManager?: HookSecretManager;
}

// Messages posted from the webview. `command` selects the handler; the remaining
// fields are optional because each command only sends the subset it needs.
interface DeploymentSettingsMessage {
  command: string;
  payload?: unknown;
  id?: string;
  serverId?: string;
  index?: number;
  mappings?: Array<{ localPath: string; remotePath: string }>;
  excludedPaths?: string[];
  server?: { id?: string; type?: string; credentialId?: string; rootPath?: string };
  credentialId?: string;
  startPath?: string;
  serverType?: string;
  hooks?: ProjectServer['hooks'];
  name?: string;
  newName?: string;
  value?: string;
  hookCommand?: string;
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

  private async handleMessage(msg: DeploymentSettingsMessage): Promise<void> {
    switch (msg.command) {
      case 'ready':
        await this.sendInitialState();
        break;

      case 'saveServer':
        await this.handleSaveServer((msg.payload ?? {}) as Partial<ProjectServer> & { name?: string });
        break;

      case 'deleteServer': {
        if (!msg.id) break;
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

      case 'setDefaultServer': {
        if (!msg.id) break;
        await this.dependencies.configManager.setDefaultServer(msg.id);
        const configAfterDefault = await this.dependencies.configManager.getConfig();
        this.panel.webview.postMessage({ command: 'configUpdated', config: configAfterDefault });
        break;
      }

      case 'saveMapping': {
        if (!msg.serverId || !msg.mappings || !msg.excludedPaths) break;
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
        if (!msg.serverId || msg.index === undefined) break;
        await this.handleDeleteMapping(msg.serverId, msg.index);
        break;

      case 'saveHooks':
        if (!msg.serverId) break;
        await this.handleSaveHooks(msg.serverId, msg.hooks);
        break;

      case 'storeSecret':
        if (!msg.name || msg.value === undefined) break;
        await this.handleStoreSecret(msg.name, msg.value);
        break;

      case 'deleteSecret':
        if (!msg.name) break;
        await this.handleDeleteSecret(msg.name);
        break;

      case 'renameSecret':
        if (!msg.name || !msg.newName) break;
        await this.handleRenameSecret(msg.name, msg.newName);
        break;

      case 'moveSecretToKeychain':
        if (!msg.serverId || !msg.hookCommand || !msg.name) break;
        await this.handleMoveSecretToKeychain(msg.serverId, msg.hookCommand, msg.name);
        break;

      case 'testConnection':
        if (!msg.server) break;
        await this.handleTestConnection(msg.server);
        break;

      case 'detectTimeOffset':
        if (!msg.server) break;
        await this.handleDetectTimeOffset(msg.server);
        break;

      case 'cloneServer': {
        if (!msg.id) break;
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
        if (!msg.credentialId) break;
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
    // Names only — secret values never leave the extension host. The webview
    // renders them as write-only rows and computes missing-secret indicators
    // by scanning hook commands against this list.
    const secretNames = this.dependencies.hookSecretManager?.listNames() ?? [];
    this.panel.webview.postMessage({ command: 'init', config, credentials, secretNames });
  }

  private postSecretNames(): void {
    const secretNames = this.dependencies.hookSecretManager?.listNames() ?? [];
    this.panel.webview.postMessage({ command: 'secretsUpdated', secretNames });
  }

  private postSecretError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.panel.webview.postMessage({ command: 'secretError', message });
  }

  private async handleStoreSecret(name: string, value: string): Promise<void> {
    const manager = this.dependencies.hookSecretManager;
    if (!manager) {
      this.postSecretError('Open a workspace folder to store hook secrets.');
      return;
    }
    try {
      await manager.store(name, value);
    } catch (error: unknown) {
      this.postSecretError(error);
      return;
    }
    this.postSecretNames();
  }

  private async handleDeleteSecret(name: string): Promise<void> {
    const manager = this.dependencies.hookSecretManager;
    if (!manager) {
      this.postSecretError('Open a workspace folder to manage hook secrets.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete secret "${name}" from the OS keychain? Hooks referencing \${secret:${name}} will fail until it is re-added.`,
      'Delete', 'Cancel'
    );
    if (answer !== 'Delete') return;
    try {
      await manager.delete(name);
    } catch (error: unknown) {
      this.postSecretError(error);
      return;
    }
    this.postSecretNames();
  }

  private async handleRenameSecret(oldName: string, newName: string): Promise<void> {
    const manager = this.dependencies.hookSecretManager;
    if (!manager) {
      this.postSecretError('Open a workspace folder to manage hook secrets.');
      return;
    }
    try {
      await manager.rename(oldName, newName);
    } catch (error: unknown) {
      this.postSecretError(error);
      return;
    }
    this.postSecretNames();
  }

  // The one-click fix on a detectSecret warning (#27b): store the flagged
  // literal in the keychain, rewrite the saved command to ${secret:NAME}, and
  // re-run the scan so remaining warnings survive and this one clears.
  private async handleMoveSecretToKeychain(serverId: string, hookCommand: string, name: string): Promise<void> {
    const manager = this.dependencies.hookSecretManager;
    if (!manager) {
      this.postSecretError('Open a workspace folder to store hook secrets.');
      return;
    }
    const entry = await this.dependencies.configManager.getServerById(serverId);
    if (!entry) return;

    const literal = findSecretLiteral(hookCommand);
    if (!literal) {
      this.postSecretError('No secret-looking literal found in that command — edit it manually instead.');
      return;
    }

    try {
      await manager.store(name, literal);
    } catch (error: unknown) {
      this.postSecretError(error);
      return;
    }

    const token = `\${secret:${name}}`;
    const rewriteHook = (hook: HookCommand): HookCommand =>
      hook.command === hookCommand
        ? { ...hook, command: hook.command.split(literal).join(token) }
        : hook;
    const existingHooks = entry.server.hooks ?? {};
    const updatedHooks = {
      preDeploy: (existingHooks.preDeploy ?? []).map(rewriteHook),
      postDeploy: (existingHooks.postDeploy ?? []).map(rewriteHook),
    };
    await this.dependencies.configManager.setServerHooks(entry.name, updatedHooks);

    // Same ordering rule as handleSaveHooks: configUpdated re-renders the tab,
    // so any surviving warnings must be posted after it.
    const config = await this.dependencies.configManager.getConfig();
    this.panel.webview.postMessage({ command: 'configUpdated', config });
    this.postSecretNames();

    const stillFlagged = [...updatedHooks.preDeploy, ...updatedHooks.postDeploy]
      .map(hook => hook.command)
      .filter(command => detectSecret(command));
    if (stillFlagged.length > 0) {
      this.panel.webview.postMessage({ command: 'hookSecretWarning', commands: stillFlagged });
    }

    vscode.window.showInformationMessage(
      `FileFerry: Secret stored in the OS keychain as "${name}" — the hook now references \${secret:${name}}.`
    );
  }

  private async handleSaveServer(payload: Partial<ProjectServer> & { name?: string }): Promise<void> {
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
      // The Mappings tab is editable before the first save now, so honour
      // payload-supplied mappings/excludedPaths (new servers and edits alike),
      // falling back to the saved values when the payload omits them.
      mappings: payload.mappings ?? existing?.mappings ?? [],
      excludedPaths: payload.excludedPaths ?? existing?.excludedPaths ?? [],
      ...(payload.filePermissions !== undefined ? { filePermissions: payload.filePermissions } : {}),
      ...(payload.directoryPermissions !== undefined ? { directoryPermissions: payload.directoryPermissions } : {}),
      ...(existing?.timeOffsetMs !== undefined ? { timeOffsetMs: existing.timeOffsetMs } : {}),
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

  private async handleSaveHooks(serverId: string, hooks: ProjectServer['hooks']): Promise<void> {
    const entry = await this.dependencies.configManager.getServerById(serverId);
    if (!entry) return;

    // Hooks edited here live in the committed fileferry.json (the team-shared
    // config); secrets belong in the keychain, referenced as ${secret:NAME}.
    await this.dependencies.configManager.setServerHooks(entry.name, hooks);

    // Re-render the panel FIRST — configUpdated rebuilds the Hooks-tab DOM. The
    // secret warning must be posted AFTER so it lands on the freshly-rendered
    // rows; posting it before would let the re-render wipe the inline warning.
    const config = await this.dependencies.configManager.getConfig();
    this.panel.webview.postMessage({ command: 'configUpdated', config });

    // Advisory secret scan — never blocks the save. Flag commands that look like
    // they embed a literal secret so the webview can warn inline and offer the
    // one-click "Move to keychain" fix.
    const flaggedCommands = [...(hooks?.preDeploy ?? []), ...(hooks?.postDeploy ?? [])]
      .map(hook => hook.command)
      .filter(command => detectSecret(command));
    if (flaggedCommands.length > 0) {
      this.panel.webview.postMessage({ command: 'hookSecretWarning', commands: flaggedCommands });
    }

    vscode.window.showInformationMessage(`FileFerry: Hooks saved for "${entry.name}".`);
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

  private async handleTestConnection(server: { id?: string; type?: string; credentialId?: string; rootPath?: string }): Promise<void> {
    if (!server?.credentialId) {
      this.panel.webview.postMessage({ command: 'testResult', success: false, message: 'Credential must be selected' });
      return;
    }

    const existingCredentials = await this.dependencies.credentialManager.getAll();
    if (!existingCredentials.some(c => c.id === server.credentialId)) {
      this.panel.webview.postMessage({ command: 'testResult', success: false, message: 'Selected credential no longer exists' });
      return;
    }

    const credential = await this.dependencies.credentialManager.getWithSecret(server.credentialId);

    // FTP/FTPS only supports password authentication
    const isFtp = server.type !== 'sftp';
    if (isFtp && credential.authMethod !== 'password') {
      this.panel.webview.postMessage({
        command: 'testResult',
        success: false,
        message: 'FTP/FTPS only supports password authentication. Change the credential auth method to "Password".',
      });
      return;
    }

    const service = createTransferService((server.type ?? 'sftp') as ServerType);
    try {
      await service.connect(credential, { password: credential.password, passphrase: credential.passphrase });

      const timeOffsetMs = await new TimeOffsetDetector().detect(service);

      // Probe the configured Root Path so the user finds out it's wrong here,
      // not on the next upload. Non-blocking: connection succeeded, this is a
      // warning. Skip when the field is empty (Save validation handles that).
      let warning: string | undefined;
      const trimmedRoot = server.rootPath?.trim();
      if (trimmedRoot) {
        try {
          await service.listDirectory(trimmedRoot);
        } catch (probeErr: unknown) {
          warning = `Root Path "${trimmedRoot}" not accessible on remote: ${(probeErr as Error).message}. Use Browse to pick a valid folder.`;
        }
      }

      await service.disconnect();

      // Only persist the offset when the server is already saved (has an id)
      if (server.id) {
        const entry = await this.dependencies.configManager.getServerById(server.id);
        const config = await this.dependencies.configManager.getConfig();
        if (entry && config) {
          config.servers[entry.name] = { ...entry.server, timeOffsetMs };
          await this.dependencies.configManager.saveConfig(config);
        }
      }

      this.panel.webview.postMessage({ command: 'testResult', success: true, message: 'Connected successfully', timeOffsetMs, warning });
    } catch (err: unknown) {
      this.panel.webview.postMessage({
        command: 'testResult',
        success: false,
        message: (err as Error).message,
      });
    }
  }

  private async handleDetectTimeOffset(server: { id?: string; type?: string; credentialId?: string }): Promise<void> {
    if (!server?.credentialId) {
      this.panel.webview.postMessage({ command: 'testResult', success: false, message: 'Credential must be selected' });
      return;
    }

    const credential = await this.dependencies.credentialManager.getWithSecret(server.credentialId);
    const service = createTransferService((server.type ?? 'sftp') as ServerType);
    try {
      await service.connect(credential, { password: credential.password, passphrase: credential.passphrase });

      const timeOffsetMs = await new TimeOffsetDetector().detect(service);
      await service.disconnect();

      // Only persist the offset when the server is already saved (has an id)
      if (server.id) {
        const entry = await this.dependencies.configManager.getServerById(server.id);
        const config = await this.dependencies.configManager.getConfig();
        if (entry && config) {
          config.servers[entry.name] = { ...entry.server, timeOffsetMs };
          await this.dependencies.configManager.saveConfig(config);
        }
      }

      this.panel.webview.postMessage({ command: 'testResult', success: true, timeOffsetMs });
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
        <button class="tab-btn" data-tab="hooks">Hooks</button>
      </div>
      <div id="connection-tab" class="tab-content active"></div>
      <div id="mappings-tab" class="tab-content"></div>
      <div id="hooks-tab" class="tab-content"></div>
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

    const sftp = createTransferService((serverType ?? 'sftp') as ServerType);
    try {
      await sftp.connect(credential, { password: credential.password, passphrase: credential.passphrase });
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
