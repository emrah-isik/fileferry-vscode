import * as vscode from 'vscode';
import { RemoteFileItem } from '../remoteBrowser/RemoteFileItem';

export async function copyRemotePath(targets: RemoteFileItem[]): Promise<void> {
  if (targets.length === 0) {
    return;
  }

  const remotePaths = targets.map(target => target.entry.remotePath);
  await vscode.env.clipboard.writeText(remotePaths.join('\n'));

  if (remotePaths.length === 1) {
    vscode.window.showInformationMessage(`Copied: ${remotePaths[0]}`);
  } else {
    vscode.window.showInformationMessage(`Copied ${remotePaths.length} remote paths`);
  }
}
