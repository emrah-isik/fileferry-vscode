import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../path/PathResolver';
import { DiffService } from '../diffService';
import { SftpService } from '../sftpService';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
}

export async function showRemoteDiff(
  resource: vscode.SourceControlResourceState | undefined,
  dependencies: Dependencies
): Promise<void> {
  // Fall back to active editor when invoked via keybinding with no SCM selection
  if (!resource) {
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    if (editorUri) {
      resource = { resourceUri: editorUri } as vscode.SourceControlResourceState;
    } else {
      vscode.window.showErrorMessage('FileFerry: No file selected.');
      return;
    }
  }

  const config = await dependencies.configManager.getConfig();
  if (!config) {
    vscode.window.showErrorMessage(
      'FileFerry: No project configuration found. Run "FileFerry: Deployment Settings" to configure.'
    );
    return;
  }

  const match = await dependencies.configManager.getServerById(config.defaultServerId);
  if (!match) {
    vscode.window.showErrorMessage(
      'FileFerry: Default server not found. Open Deployment Settings to fix.'
    );
    return;
  }

  const { name: serverName, server } = match;

  if (server.mappings.length === 0) {
    vscode.window.showErrorMessage(
      `FileFerry: No mappings configured for server "${serverName}".`
    );
    return;
  }

  const localPath = resource.resourceUri.fsPath;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const pathResolver = new PathResolver();

  let remotePath: string;
  try {
    const resolved = pathResolver.resolve(localPath, workspaceRoot, {
      rootPath: server.rootPath,
      mappings: server.mappings,
      excludedPaths: server.excludedPaths,
    });
    remotePath = resolved.remotePath;
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`FileFerry: ${(err as Error).message}`);
    return;
  }

  const credential = await dependencies.credentialManager.getWithSecret(server.credentialId);
  const tempDir = path.join(os.tmpdir(), 'fileferry');
  const diffService = new DiffService(new SftpService(), tempDir);
  const fileName = path.basename(localPath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `FileFerry: Fetching remote "${fileName}" from "${serverName}"`,
      cancellable: false,
    },
    async () => {
      let tempPath: string;
      try {
        tempPath = await diffService.downloadRemoteFile(
          credential as any,
          { password: credential.password, passphrase: credential.passphrase },
          remotePath
        );
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`FileFerry: ${(err as Error).message}`);
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(tempPath),
        resource.resourceUri,
        `${fileName} (Remote: ${serverName}) ↔ ${fileName} (Local)`
      );
    }
  );
}
