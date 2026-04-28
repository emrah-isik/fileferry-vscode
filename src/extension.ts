import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CredentialManager } from './storage/CredentialManager';
import { ProjectConfigManager } from './storage/ProjectConfigManager';
import { migrateIfNeeded } from './storage/ConfigMigration';
import { uploadSelected } from './commands/uploadSelected';
import { uploadToServers } from './commands/uploadToServers';
import { uploadAllChanged } from './commands/uploadAllChanged';
import { showRemoteDiff } from './commands/showRemoteDiff';
import { normalizeCommandArgs } from './utils/normalizeCommandArgs';
import { StatusBarItem } from './ui/StatusBarItem';
import { DeploymentSettingsPanel } from './ui/webviews/DeploymentSettingsPanel';
import { ProjectSettingsPanel } from './ui/webviews/ProjectSettingsPanel';
import { UploadHistoryPanel } from './ui/webviews/UploadHistoryPanel';
import { SshCredentialPanel } from './ui/webviews/SshCredentialPanel';
import { RemoteBrowserConnection } from './remoteBrowser/RemoteBrowserConnection';
import { RemoteBrowserProvider } from './remoteBrowser/RemoteBrowserProvider';
import { ServersProvider } from './remoteBrowser/ServersProvider';
import { openRemoteFile } from './commands/openRemoteFile';
import { copyRemotePath } from './commands/copyRemotePath';
import { downloadToWorkspace } from './commands/downloadToWorkspace';
import { diffRemoteWithLocal } from './commands/diffRemoteWithLocal';
import { deleteRemoteItem } from './commands/deleteRemoteItem';
import { UploadOnSaveService } from './services/UploadOnSaveService';
import { DeploymentServer } from './models/DeploymentServer';
import { ProjectBinding } from './models/ProjectBinding';

let output: vscode.OutputChannel;

function withErrorHandling(label: string, fn: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`[error] ${label}: ${message}`);
      vscode.window.showErrorMessage(`FileFerry: ${message}`);
    }
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('FileFerry');
  context.subscriptions.push(output);

  const credentialManager = new CredentialManager(context);
  const configManager = new ProjectConfigManager();

  // Migrate old servers.json + project binding → new fileferry.json on first activation
  const oldServersPath = path.join(context.globalStorageUri.fsPath, 'servers.json');
  migrateIfNeeded({
    getExistingConfig: () => configManager.getConfig(),
    readOldServers: () => readJsonFile<DeploymentServer[]>(oldServersPath).then(s => s ?? []),
    readOldBinding: () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) { return Promise.resolve(null); }
      const bindingPath = path.join(folders[0].uri.fsPath, '.vscode', 'fileferry.json');
      return readJsonFile<ProjectBinding>(bindingPath);
    },
    getCredentials: () => credentialManager.getAll(),
    saveConfig: (config) => configManager.saveConfig(config),
  }).then(migrated => {
    if (migrated) {
      output.appendLine('[info] Migrated legacy server configuration to new project-scoped format.');
    }
  }).catch(err => {
    output.appendLine(`[warn] Config migration failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  const statusBar = new StatusBarItem(context, configManager);
  context.subscriptions.push(statusBar);

  const uploadOnSave = new UploadOnSaveService({ credentialManager, configManager });
  context.subscriptions.push(uploadOnSave.register());

  const credentialsChangedEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(credentialsChangedEmitter);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'fileferry.uploadSelected',
      (arg1, arg2) => {
        const { resource, allResources } = normalizeCommandArgs(arg1, arg2);
        return uploadSelected(resource, allResources, { credentialManager, configManager, context, output });
      }
    ),

    vscode.commands.registerCommand(
      'fileferry.uploadToServers',
      (arg1, arg2) => {
        const { resource, allResources } = normalizeCommandArgs(arg1, arg2);
        return uploadToServers(resource, allResources, { credentialManager, configManager, context, output });
      }
    ),

    vscode.commands.registerCommand(
      'fileferry.uploadAllChanged',
      withErrorHandling('uploadAllChanged', async () =>
        uploadAllChanged({ credentialManager, configManager, context, output })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.openSettings',
      withErrorHandling('openSettings', async () =>
        DeploymentSettingsPanel.createOrShow(context, { credentialManager, configManager, credentialsChanged: credentialsChangedEmitter.event })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.openCredentials',
      withErrorHandling('openCredentials', async () =>
        SshCredentialPanel.createOrShow(context, { credentialManager, configManager, onCredentialChange: () => credentialsChangedEmitter.fire() })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.switchServer',
      withErrorHandling('switchServer', async () => {
        const config = await configManager.getConfig();
        if (!config || Object.keys(config.servers).length === 0) {
          vscode.window.showWarningMessage(
            'FileFerry: No servers configured. Open Deployment Settings to add one.'
          );
          return;
        }
        const items = Object.entries(config.servers).map(([name, server]) => ({
          label: name,
          description: server.id === config.defaultServerId ? '(current default)' : server.rootPath,
          id: server.id,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select default deployment server for this project',
        });
        if (picked) {
          await configManager.setDefaultServer(picked.id);
          statusBar.refresh();
          vscode.window.showInformationMessage(
            `FileFerry: Default server set to "${picked.label}"`
          );
        }
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.showRemoteDiff',
      (arg1) => {
        const { resource } = normalizeCommandArgs(arg1, undefined);
        return showRemoteDiff(resource, { credentialManager, configManager });
      }
    ),

    vscode.commands.registerCommand(
      'fileferry.resetConfirmations',
      withErrorHandling('resetConfirmations', async () => {
        vscode.window.showInformationMessage('FileFerry: Upload confirmations reset.');
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.statusBarMenu',
      withErrorHandling('statusBarMenu', () => statusBar.showMenu())
    ),

    vscode.commands.registerCommand(
      'fileferry.toggleUploadOnSave',
      withErrorHandling('toggleUploadOnSave', async () => {
        const newValue = await configManager.toggleUploadOnSave();
        statusBar.refresh();
        vscode.window.showInformationMessage(
          `FileFerry: Upload on save ${newValue ? 'enabled' : 'disabled'}.`
        );
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.toggleDryRun',
      withErrorHandling('toggleDryRun', async () => {
        const newValue = await configManager.toggleDryRun();
        statusBar.refresh();
        vscode.window.showInformationMessage(
          `FileFerry: Dry run mode ${newValue ? 'enabled' : 'disabled'}.`
        );
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.openProjectSettings',
      withErrorHandling('openProjectSettings', async () =>
        ProjectSettingsPanel.createOrShow(context, { configManager })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.showUploadHistory',
      withErrorHandling('showUploadHistory', async () =>
        UploadHistoryPanel.createOrShow(context, { configManager })
      )
    )
  );

  // Servers View
  const serversProvider = new ServersProvider(configManager, credentialManager);

  const serversTreeView = vscode.window.createTreeView('fileferry.serversView', {
    treeDataProvider: serversProvider,
  });

  // Set context key for welcome views
  async function updateHasServersContext(): Promise<void> {
    const config = await configManager.getConfig();
    const count = config ? Object.keys(config.servers).length : 0;
    await vscode.commands.executeCommand('setContext', 'fileferry.hasServers', count > 0);
  }
  updateHasServersContext();

  // Remote File Browser
  const browserConnection = new RemoteBrowserConnection(
    credentialManager, configManager, output,
    context.globalStorageUri.fsPath
  );
  const browserProvider = new RemoteBrowserProvider(browserConnection);

  const browserTreeView = vscode.window.createTreeView('fileferry.remoteBrowser', {
    treeDataProvider: browserProvider,
    showCollapseAll: true,
  });

  // Update path indicator in Remote Files view header
  browserProvider.onDidChangePath(path => {
    browserTreeView.description = path || undefined;
  });

  context.subscriptions.push(
    serversTreeView,
    browserTreeView,
    { dispose: () => browserConnection.dispose() },

    // Servers commands
    vscode.commands.registerCommand(
      'fileferry.servers.setDefault',
      withErrorHandling('setDefault', async (serverId: string) => {
        await configManager.setDefaultServer(serverId);
        statusBar.refresh();
        serversProvider.refresh();
        browserProvider.refresh();
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.servers.refresh',
      () => {
        serversProvider.refresh();
        updateHasServersContext();
      }
    ),

    vscode.commands.registerCommand(
      'fileferry.servers.editServer',
      withErrorHandling('editServer', async () =>
        DeploymentSettingsPanel.createOrShow(context, { credentialManager, configManager, credentialsChanged: credentialsChangedEmitter.event })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.servers.testConnection',
      withErrorHandling('testConnection', async (item: any) => {
        const serverId = item?.serverId ?? item;
        const entry = await configManager.getServerById(serverId);
        if (!entry) {
          vscode.window.showErrorMessage('FileFerry: Server not found.');
          return;
        }
        const credential = await credentialManager.getWithSecret(entry.server.credentialId);
        const { SftpService } = await import('./sftpService');
        const sftp = new SftpService();
        try {
          await sftp.connect(
            credential as any,
            { password: credential.password, passphrase: credential.passphrase }
          );
          await sftp.disconnect();
          vscode.window.showInformationMessage(`FileFerry: Connection to "${entry.name}" successful.`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`FileFerry: Connection to "${entry.name}" failed — ${message}`);
        }
      })
    ),

    // Remote browser commands
    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.refresh',
      () => browserProvider.refresh()
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.openFile',
      (entry) => openRemoteFile(entry, browserConnection)
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.copyPath',
      (item: any) => copyRemotePath(item)
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.downloadToWorkspace',
      withErrorHandling('downloadToWorkspace', async (item: any) => {
        await downloadToWorkspace(item.entry, browserConnection, configManager);
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.diffWithLocal',
      withErrorHandling('diffWithLocal', async (item: any) => {
        await diffRemoteWithLocal(item.entry, browserConnection, configManager);
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.delete',
      (item: any) => deleteRemoteItem(item, browserConnection, () => browserProvider.refresh())
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.navigateTo',
      withErrorHandling('navigateTo', async () => {
        const path = await vscode.window.showInputBox({
          prompt: 'Enter remote path to browse',
          value: browserConnection.getRootPath(),
        });
        if (path) {
          browserProvider.navigateTo(path);
        }
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.disconnect',
      withErrorHandling('disconnect', async () => {
        await browserConnection.disconnect();
        browserProvider.refresh();
        vscode.window.showInformationMessage('FileFerry: Remote browser disconnected.');
      })
    ),

    // Refresh views when project config changes
    vscode.workspace.createFileSystemWatcher('**/.vscode/fileferry.json').onDidChange(
      () => {
        serversProvider.refresh();
        browserProvider.refresh();
      }
    ),

    // Refresh servers view when credentials change
    credentialsChangedEmitter.event(() => {
      serversProvider.refresh();
      updateHasServersContext();
    })
  );
}

export function deactivate(): void {
  // VSCode cleans up context.subscriptions automatically
}
