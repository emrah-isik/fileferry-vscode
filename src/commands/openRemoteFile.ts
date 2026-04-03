import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';

const TEMP_DIR = path.join(os.tmpdir(), 'fileferry-browse');

function getTempPath(remotePath: string): string {
  const hash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
  const ext = path.extname(remotePath);
  const base = path.basename(remotePath, ext);
  return path.join(TEMP_DIR, `${base}.remote.${hash}${ext}`);
}

export async function openRemoteFile(
  entry: RemoteEntry,
  connection: RemoteBrowserConnection
): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Downloading ${entry.name}...`,
      },
      async () => {
        const content = await connection.downloadFile(entry.remotePath);
        const tempPath = getTempPath(entry.remotePath);
        await fs.mkdir(TEMP_DIR, { recursive: true });
        await fs.writeFile(tempPath, content);

        const doc = await vscode.workspace.openTextDocument(tempPath);
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to open remote file — ${message}`);
  }
}
