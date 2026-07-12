import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { RemoteEntry } from '../remoteBrowser/RemoteFileItem';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { RemoteEditSessionRegistry } from '../services/RemoteEditSessionRegistry';

const TEMP_DIR = path.join(os.tmpdir(), 'fileferry-browse');

function getTempPath(remotePath: string): string {
  const hash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
  const ext = path.extname(remotePath);
  const base = path.basename(remotePath, ext);
  return path.join(TEMP_DIR, `${base}.remote.${hash}${ext}`);
}

export async function openRemoteFile(
  entry: RemoteEntry,
  connection: RemoteBrowserConnection,
  registry: RemoteEditSessionRegistry
): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Downloading ${entry.name}...`,
      },
      async () => {
        // The conflict baseline is statted BEFORE the download: if the remote
        // changes inside the stat→download window, the downloaded bytes are
        // newer than the baseline, so a later save reads as a conflict and the
        // sha256 check resolves it. Statted after, a change in the window
        // would be invisible and silently overwritten on save.
        // An unreadable mtime stays NaN — the save listener fails closed on it.
        let downloadedMtimeMs = Number.NaN;
        try {
          const remoteStat = await connection.statRemote(entry.remotePath);
          if (remoteStat) {
            downloadedMtimeMs = remoteStat.mtime.getTime();
          }
        } catch {
          // stat failure must not block opening the file
        }

        const content = await connection.downloadFile(entry.remotePath);
        const tempPath = getTempPath(entry.remotePath);
        await fs.mkdir(TEMP_DIR, { recursive: true });
        await fs.writeFile(tempPath, content);

        const doc = await vscode.workspace.openTextDocument(tempPath);
        await vscode.window.showTextDocument(doc, { preview: true });

        const serverId = connection.getCurrentServerId();
        if (serverId === null) {
          // Unreachable after a successful download in practice, but if the
          // session cannot be bound to a server, saying nothing would make
          // every save a silent no-op.
          vscode.window.showWarningMessage(
            `FileFerry: Could not determine which server ${entry.name} came from — saves in this editor will not upload back.`
          );
          return;
        }

        // Keyed by the editor's own fsPath, not tempPath: VS Code normalises
        // the path (e.g. Windows drive-letter casing), and the save event
        // reports the normalised form — a mismatched key would make saves
        // silently no-op.
        registry.register(doc.uri.fsPath, {
          serverId,
          remotePath: entry.remotePath,
          downloadedMtimeMs,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        });
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FileFerry: Failed to open remote file — ${message}`);
  }
}
