import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CredentialManager } from './storage/CredentialManager';
import { ProjectConfigManager } from './storage/ProjectConfigManager';
import { HookSecretManager } from './storage/HookSecretManager';
import { migrateIfNeeded } from './storage/ConfigMigration';
import { makeUploadSelectedHandler } from './commands/uploadSelectedHandler';
import { makeUploadToServersHandler } from './commands/uploadToServersHandler';
import { makeSyncToRemoteHandler } from './commands/syncToRemoteHandler';
import { makeSyncFolderToRemoteHandler } from './commands/syncFolderToRemoteHandler';
import { makeShowRemoteDiffHandler } from './commands/showRemoteDiffHandler';
import { uploadAllChanged } from './commands/uploadAllChanged';
import { uploadOnlyNewer } from './commands/uploadOnlyNewer';
import { uploadFromCommits } from './commands/uploadFromCommits';
import { StatusBarItem } from './ui/StatusBarItem';
import { DeploymentSettingsPanel } from './ui/webviews/DeploymentSettingsPanel';
import { ProjectSettingsPanel } from './ui/webviews/ProjectSettingsPanel';
import { UploadHistoryPanel } from './ui/webviews/UploadHistoryPanel';
import { SshCredentialPanel } from './ui/webviews/SshCredentialPanel';
import { RemoteBrowserConnection } from './remoteBrowser/RemoteBrowserConnection';
import { RemoteFileItem } from './remoteBrowser/RemoteFileItem';
import { ServerConfig } from './types';
import { RemoteBrowserProvider } from './remoteBrowser/RemoteBrowserProvider';
import { ServersProvider } from './remoteBrowser/ServersProvider';
import { openRemoteFile } from './commands/openRemoteFile';
import { copyRemotePath } from './commands/copyRemotePath';
import { downloadToWorkspace } from './commands/downloadToWorkspace';
import { diffRemoteWithLocal } from './commands/diffRemoteWithLocal';
import { deleteRemoteItem } from './commands/deleteRemoteItem';
import { UploadOnSaveService } from './services/UploadOnSaveService';
import { FileWatcherService } from './services/FileWatcherService';
import { DeploymentServer } from './models/DeploymentServer';
import { ProjectBinding } from './models/ProjectBinding';
import { withErrorHandling as wrapErrors } from './utils/withErrorHandling';
import { GitService } from './gitService';
import { ChangedFilesView } from './changedFiles/ChangedFilesView';
import { uploadChangedFilesSelection } from './commands/uploadChangedFilesSelection';
import { uploadChangedFilesOnlyNewer } from './commands/uploadChangedFilesOnlyNewer';

let output: vscode.OutputChannel;

// Per-project keychain store for ${secret:NAME} hook secrets; undefined when
// no workspace folder is open (the settings panel reports that on use).
function makeHookSecretManager(context: vscode.ExtensionContext): HookSecretManager | undefined {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return workspaceRoot ? new HookSecretManager(context, workspaceRoot) : undefined;
}

function withErrorHandling<Args extends unknown[]>(
  label: string,
  fn: (...args: Args) => Promise<void>
): (...args: Args) => Promise<void> {
  return wrapErrors(label, output, fn as (...args: unknown[]) => Promise<void>) as (
    ...args: Args
  ) => Promise<void>;
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

  const fileWatcher = new FileWatcherService({ credentialManager, configManager, output });
  context.subscriptions.push(fileWatcher.register());

  const credentialsChangedEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(credentialsChangedEmitter);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'fileferry.uploadSelected',
      withErrorHandling('uploadSelected',
        makeUploadSelectedHandler({ credentialManager, configManager, context, output })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.uploadToServers',
      withErrorHandling('uploadToServers',
        makeUploadToServersHandler({ credentialManager, configManager, context, output })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.syncToRemote',
      withErrorHandling('syncToRemote',
        makeSyncToRemoteHandler({ credentialManager, configManager, context, output })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.syncFolderToRemote',
      withErrorHandling('syncFolderToRemote',
        makeSyncFolderToRemoteHandler({ credentialManager, configManager, context, output })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.uploadAllChanged',
      withErrorHandling('uploadAllChanged', async () =>
        uploadAllChanged({ credentialManager, configManager, context, output })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.uploadOnlyNewer',
      withErrorHandling('uploadOnlyNewer', async () =>
        uploadOnlyNewer({ credentialManager, configManager, context, output })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.uploadFromCommits',
      withErrorHandling('uploadFromCommits', async (arg1: unknown, arg2: unknown) =>
        uploadFromCommits(arg1, arg2, { credentialManager, configManager, context, output })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.openSettings',
      withErrorHandling('openSettings', async () =>
        DeploymentSettingsPanel.createOrShow(context, {
          credentialManager,
          configManager,
          credentialsChanged: credentialsChangedEmitter.event,
          hookSecretManager: makeHookSecretManager(context),
        })
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
      withErrorHandling('showRemoteDiff',
        makeShowRemoteDiffHandler({ credentialManager, configManager })
      )
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

  // Changed Files view — our own SCM-like tree we can read selection from.
  // VSCode's SCM view doesn't expose its selection to keybinding-invoked
  // commands; owning the tree sidesteps that limitation.
  const gitService = new GitService();
  const changedFilesView = new ChangedFilesView('fileferry.changedFilesView', gitService);
  context.subscriptions.push(changedFilesView);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'fileferry.changedFiles.refresh',
      withErrorHandling('changedFiles.refresh', async () => changedFilesView.refresh())
    ),
    vscode.commands.registerCommand(
      'fileferry.changedFiles.uploadSelection',
      withErrorHandling('changedFiles.uploadSelection', async () =>
        uploadChangedFilesSelection(
          () => changedFilesView.getSelection(),
          { credentialManager, configManager, context, output }
        )
      )
    ),
    vscode.commands.registerCommand(
      'fileferry.changedFiles.uploadOnlyNewer',
      withErrorHandling('changedFiles.uploadOnlyNewer', async () =>
        uploadChangedFilesOnlyNewer(
          () => changedFilesView.getSelection(),
          { credentialManager, configManager, context, output }
        )
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
        DeploymentSettingsPanel.createOrShow(context, {
          credentialManager,
          configManager,
          credentialsChanged: credentialsChangedEmitter.event,
          hookSecretManager: makeHookSecretManager(context),
        })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.servers.testConnection',
      withErrorHandling('testConnection', async (item: { serverId?: string } | string | undefined) => {
        const serverId = typeof item === 'object' ? item?.serverId : item;
        const entry = serverId ? await configManager.getServerById(serverId) : undefined;
        if (!entry) {
          vscode.window.showErrorMessage('FileFerry: Server not found.');
          return;
        }
        const credential = await credentialManager.getWithSecret(entry.server.credentialId);
        const { createTransferService } = await import('./transferServiceFactory');
        const transfer = createTransferService(entry.server.type);
        try {
          await transfer.connect(
            // SshCredentialWithSecret carries the fields connect() reads; add the
            // server type so an FTP/FTPS transport picks the right TLS mode.
            { ...(credential as unknown as ServerConfig), type: entry.server.type },
            { password: credential.password, passphrase: credential.passphrase }
          );
          await transfer.disconnect();
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
      (item: RemoteFileItem | undefined) => copyRemotePath(item)
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.downloadToWorkspace',
      withErrorHandling('downloadToWorkspace', async (item: RemoteFileItem) => {
        await downloadToWorkspace(item.entry, browserConnection, configManager);
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.diffWithLocal',
      withErrorHandling('diffWithLocal', async (item: RemoteFileItem) => {
        await diffRemoteWithLocal(item.entry, browserConnection, configManager);
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.delete',
      (item: RemoteFileItem) => deleteRemoteItem(item, browserConnection, () => browserProvider.refresh())
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
