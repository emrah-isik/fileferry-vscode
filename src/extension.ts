import * as vscode from 'vscode';
import { CredentialManager } from './storage/CredentialManager';
import { ServerManager } from './storage/ServerManager';
import { ProjectBindingManager } from './storage/ProjectBindingManager';
import { uploadSelected } from './commands/uploadSelected';
import { showRemoteDiff } from './commands/showRemoteDiff';
import { normalizeCommandArgs } from './utils/normalizeCommandArgs';
import { StatusBarItem } from './ui/StatusBarItem';
import { DeploymentSettingsPanel } from './ui/webviews/DeploymentSettingsPanel';
import { SshCredentialPanel } from './ui/webviews/SshCredentialPanel';
import { RemoteBrowserConnection } from './remoteBrowser/RemoteBrowserConnection';
import { RemoteBrowserProvider } from './remoteBrowser/RemoteBrowserProvider';
import { ServersProvider } from './remoteBrowser/ServersProvider';
import { openRemoteFile } from './commands/openRemoteFile';
import { copyRemotePath } from './commands/copyRemotePath';
import { downloadToWorkspace } from './commands/downloadToWorkspace';
import { diffRemoteWithLocal } from './commands/diffRemoteWithLocal';
import { deleteRemoteItem } from './commands/deleteRemoteItem';

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

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('FileFerry');
  context.subscriptions.push(output);

  const credentialManager = new CredentialManager(context);
  const serverManager = new ServerManager(context, credentialManager);
  const bindingManager = new ProjectBindingManager();

  const statusBar = new StatusBarItem(context, bindingManager, serverManager);
  context.subscriptions.push(statusBar);

  const credentialsChangedEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(credentialsChangedEmitter);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'fileferry.uploadSelected',
      (arg1, arg2) => {
        const { resource, allResources } = normalizeCommandArgs(arg1, arg2);
        return uploadSelected(resource, allResources, { credentialManager, serverManager, bindingManager, context });
      }
    ),

    vscode.commands.registerCommand(
      'fileferry.openSettings',
      withErrorHandling('openSettings', async () =>
        DeploymentSettingsPanel.createOrShow(context, { credentialManager, serverManager, bindingManager, credentialsChanged: credentialsChangedEmitter.event })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.openCredentials',
      withErrorHandling('openCredentials', async () =>
        SshCredentialPanel.createOrShow(context, { credentialManager, serverManager, onCredentialChange: () => credentialsChangedEmitter.fire() })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.switchServer',
      withErrorHandling('switchServer', async () => {
        const servers = await serverManager.getAll();
        if (servers.length === 0) {
          vscode.window.showWarningMessage(
            'FileFerry: No servers configured. Open Deployment Settings to add one.'
          );
          return;
        }
        const binding = await bindingManager.getBinding();
        const items = servers.map(s => ({
          label: s.name,
          description: s.id === binding?.defaultServerId ? '(current default)' : s.rootPath,
          id: s.id,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select default deployment server for this project',
        });
        if (picked) {
          await bindingManager.setDefaultServer(picked.id);
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
        return showRemoteDiff(resource, { credentialManager, serverManager, bindingManager });
      }
    ),

    vscode.commands.registerCommand(
      'fileferry.resetConfirmations',
      withErrorHandling('resetConfirmations', async () => {
        vscode.window.showInformationMessage('FileFerry: Upload confirmations reset.');
      })
    )
  );

  // Servers View
  const serversProvider = new ServersProvider(serverManager, credentialManager, bindingManager);

  const serversTreeView = vscode.window.createTreeView('fileferry.serversView', {
    treeDataProvider: serversProvider,
  });

  // Set context key for welcome views
  async function updateHasServersContext(): Promise<void> {
    const servers = await serverManager.getAll();
    await vscode.commands.executeCommand('setContext', 'fileferry.hasServers', servers.length > 0);
  }
  updateHasServersContext();

  // Remote File Browser
  const browserConnection = new RemoteBrowserConnection(
    credentialManager, serverManager, bindingManager, output,
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
        await bindingManager.setDefaultServer(serverId);
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
        DeploymentSettingsPanel.createOrShow(context, { credentialManager, serverManager, bindingManager, credentialsChanged: credentialsChangedEmitter.event })
      )
    ),

    vscode.commands.registerCommand(
      'fileferry.servers.testConnection',
      withErrorHandling('testConnection', async (item: any) => {
        const serverId = item?.serverId ?? item;
        const server = await serverManager.getServer(serverId);
        if (!server) {
          vscode.window.showErrorMessage('FileFerry: Server not found.');
          return;
        }
        const credential = await credentialManager.getWithSecret(server.credentialId);
        const { SftpService } = await import('./sftpService');
        const sftp = new SftpService();
        try {
          await sftp.connect(
            { ...credential, id: server.id, name: server.name, type: server.type, mappings: [], excludedPaths: [] },
            { password: credential.password, passphrase: credential.passphrase }
          );
          await sftp.disconnect();
          vscode.window.showInformationMessage(`FileFerry: Connection to "${server.name}" successful.`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`FileFerry: Connection to "${server.name}" failed — ${message}`);
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
        await downloadToWorkspace(item.entry, browserConnection, bindingManager, serverManager);
      })
    ),

    vscode.commands.registerCommand(
      'fileferry.remoteBrowser.diffWithLocal',
      withErrorHandling('diffWithLocal', async (item: any) => {
        await diffRemoteWithLocal(item.entry, browserConnection, bindingManager, serverManager);
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

    // Refresh views when project binding changes
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
