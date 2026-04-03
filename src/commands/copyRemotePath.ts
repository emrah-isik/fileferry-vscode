import * as vscode from 'vscode';
import { RemoteFileItem } from '../remoteBrowser/RemoteFileItem';

export async function copyRemotePath(item: RemoteFileItem | undefined): Promise<void> {
  const remotePath = item?.entry?.remotePath;
  if (!remotePath) {
    return;
  }
  await vscode.env.clipboard.writeText(remotePath);
  vscode.window.showInformationMessage(`Copied: ${remotePath}`);
}
