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

let output: vscode.OutputChannel;

function withErrorHandling(label: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
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
}

export function deactivate(): void {
  // VSCode cleans up context.subscriptions automatically
}
