import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { PathResolver } from '../path/PathResolver';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';

export async function downloadToWorkspace(
  entries: RemoteEntry[],
  connection: RemoteBrowserConnection,
  configManager: ProjectConfigManager
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('FileFerry: No workspace open.');
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // The command is offered on files, but a multi-selection can still contain
  // folders. There is no recursive download here — skip them, visibly.
  const downloadableEntries = entries.filter(
    entry => entry.type !== 'd' && !(entry.type === 'l' && entry.symlinkTarget === 'd')
  );
  const skippedFolderCount = entries.length - downloadableEntries.length;
  const isMultiTarget = entries.length > 1;

  // Resolve the reverse path mapping once for all entries
  type ResolveLocalPathOptions = Parameters<PathResolver['resolveLocalPath']>[2];
  let mappingOptions: ResolveLocalPathOptions | null = null;
  const config = await configManager.getConfig();
  if (config?.defaultServerId) {
    const match = await configManager.getServerById(config.defaultServerId);
    if (match) {
      const { server } = match;
      mappingOptions = {
        rootPath: server.rootPath,
        mappings: server.mappings,
        excludedPaths: server.excludedPaths,
      };
    }
  }
  const resolver = new PathResolver();

  // Resolve every local path up front — an unmapped entry prompts a save
  // dialog, and a cancelled dialog skips just that entry. Dialogs must not
  // appear under the progress notification.
  const downloadTasks: { entry: RemoteEntry; localPath: string }[] = [];
  for (const entry of downloadableEntries) {
    let localPath: string | null = null;
    if (mappingOptions) {
      localPath = resolver.resolveLocalPath(entry.remotePath, workspaceRoot, mappingOptions);
    }
    if (!localPath) {
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(workspaceRoot, entry.name)),
        filters: { 'All Files': ['*'] },
      });
      if (!saveUri) {
        continue;
      }
      localPath = saveUri.fsPath;
    }
    downloadTasks.push({ entry, localPath });
  }

  if (downloadTasks.length === 0) {
    return;
  }

  const failures: { name: string; message: string }[] = [];
  let downloadedCount = 0;

  const progressOptions: vscode.ProgressOptions = isMultiTarget
    ? {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${downloadTasks.length} files...`,
      }
    : {
        location: vscode.ProgressLocation.Window,
        title: `Downloading ${downloadTasks[0].entry.name}...`,
      };

  await vscode.window.withProgress(progressOptions, async (progress) => {
    for (const downloadTask of downloadTasks) {
      if (isMultiTarget) {
        progress.report({ message: downloadTask.entry.name });
      }
      try {
        const content = await connection.downloadFile(downloadTask.entry.remotePath);
        await fs.mkdir(path.dirname(downloadTask.localPath), { recursive: true });
        await fs.writeFile(downloadTask.localPath, content);
        downloadedCount++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ name: downloadTask.entry.name, message });
      }
    }
  });

  if (failures.length === 1 && !isMultiTarget) {
    vscode.window.showErrorMessage(`FileFerry: Failed to download — ${failures[0].message}`);
  } else if (failures.length > 0) {
    const failureDescriptions = failures.map(failure => `${failure.name}: ${failure.message}`);
    vscode.window.showErrorMessage(
      `FileFerry: Failed to download ${failures.length} of ${downloadTasks.length} files — ${failureDescriptions.join('; ')}`
    );
  }

  if (downloadedCount === 0) {
    return;
  }

  if (!isMultiTarget) {
    const relativePath = path.relative(workspaceRoot, downloadTasks[0].localPath);
    vscode.window.showInformationMessage(`FileFerry: Downloaded to ${relativePath}`);
  } else {
    let message = `FileFerry: Downloaded ${downloadedCount} file${downloadedCount === 1 ? '' : 's'}`;
    if (skippedFolderCount > 0) {
      message += ` (${skippedFolderCount} folder${skippedFolderCount === 1 ? '' : 's'} skipped — folders can't be downloaded)`;
    }
    vscode.window.showInformationMessage(message);
  }
}
