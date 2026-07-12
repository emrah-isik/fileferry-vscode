import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { RemoteBrowserConnection } from '../remoteBrowser/RemoteBrowserConnection';
import { RemoteEditSession, RemoteEditSessionRegistry } from './RemoteEditSessionRegistry';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ProjectConfig } from '../models/ProjectConfig';
import { UploadHistoryService } from './UploadHistoryService';
import { UploadHistoryEntry } from '../models/UploadHistoryEntry';
import { BackupService } from './BackupService';

interface Dependencies {
  registry: RemoteEditSessionRegistry;
  connection: RemoteBrowserConnection;
  configManager: ProjectConfigManager;
  output: vscode.OutputChannel;
}

interface ConflictCheckResult {
  outcome: 'proceed' | 'cancelled' | 'diff-shown';
  remoteExists: boolean;
  remoteBytes?: Buffer; // downloaded during the check — reused for backup/diff
}

// Uploads a save in an editor opened from the Remote Files panel back to the
// originating server (feature 32a).
//
// Deliberately does NOT go through UploadOrchestratorV2: deploy hooks (#27)
// run only for deliberate deploys, and a remote-edit save is a single-file
// write, not a deploy.
//
// Invariant: a save on a REGISTERED temp path ends in exactly one of
// upload / prompt / visible error (dry run counts as its visible log line).
// There is no silent return past the registry lookup — an editor that shows
// "saved" while the bytes went nowhere is this feature's worst failure mode.
export class RemoteEditSaveListener {
  constructor(private readonly dependencies: Dependencies) {}

  register(): vscode.Disposable {
    const saveSubscription = vscode.workspace.onDidSaveTextDocument(
      document => this.handleSave(document)
    );
    // The on-disk temp survives (recovery path); only the mapping is dropped.
    const closeSubscription = vscode.workspace.onDidCloseTextDocument(
      document => this.dependencies.registry.unregister(document.uri.fsPath)
    );
    return {
      dispose: () => {
        saveSubscription.dispose();
        closeSubscription.dispose();
      },
    };
  }

  private async handleSave(document: vscode.TextDocument): Promise<void> {
    const session = this.dependencies.registry.get(document.uri.fsPath);
    if (!session) {
      return; // not opened from the Remote Files panel
    }

    const fileName = path.basename(session.remotePath);
    try {
      await this.uploadBack(document, session, fileName);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `FileFerry: Upload of ${fileName} failed — ${message}. Your edits are saved locally at ${document.uri.fsPath}.`
      );
    }
  }

  private async uploadBack(
    document: vscode.TextDocument,
    session: RemoteEditSession,
    fileName: string
  ): Promise<void> {
    const { connection, configManager, output } = this.dependencies;

    const config = await configManager.getConfig();
    if (!config || !config.defaultServerId) {
      vscode.window.showErrorMessage(
        `FileFerry: ${fileName} was not uploaded — no server is configured. Your edits are saved locally at ${document.uri.fsPath}.`
      );
      return;
    }

    const originalServer = await configManager.getServerById(session.serverId);
    if (!originalServer) {
      vscode.window.showErrorMessage(
        `FileFerry: ${fileName} was not uploaded — the server it was opened from no longer exists. Your edits are saved locally at ${document.uri.fsPath}.`
      );
      return;
    }
    const serverName = originalServer.name;

    // The config's default server is definitionally where an upload would go:
    // ensureConnected() re-reads it on every call and silently re-targets.
    // Comparing against the live connection id instead would race a
    // default-server swap and could land the file on the wrong server.
    if (session.serverId !== config.defaultServerId) {
      const currentServer = await configManager.getServerById(config.defaultServerId);
      const currentName = currentServer ? `"${currentServer.name}"` : 'another server';
      vscode.window.showWarningMessage(
        `FileFerry: ${fileName} was opened from "${serverName}", but the Remote Files panel now targets ${currentName} — it was NOT uploaded. ` +
        `Switch the default server back to "${serverName}" and save again. Your edits are saved locally at ${document.uri.fsPath}.`
      );
      return;
    }

    if (config.dryRun) {
      output.appendLine(
        `[remote-edit] DRY RUN — would upload ${document.uri.fsPath} → ${session.remotePath} (${serverName})`
      );
      vscode.window.setStatusBarMessage(`$(beaker) Dry run — would upload ${fileName}`, 5000);
      return;
    }

    const conflict = await this.checkForConflict(document, session, serverName, fileName);
    if (conflict.outcome !== 'proceed') {
      await this.logHistory(config, session, serverName, document, 'cancelled');
      return;
    }

    if (config.backupBeforeOverwrite && conflict.remoteExists) {
      // A failure here propagates and aborts the upload: overwriting after
      // silently skipping the promised backup would defeat the setting.
      const remoteBytes = conflict.remoteBytes ?? await connection.downloadFile(session.remotePath);
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        await BackupService.writeBackup(session.remotePath, remoteBytes, serverName, workspaceRoot);
      }
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Uploading ${fileName} to ${serverName}...`,
        },
        () => connection.uploadFile(document.uri.fsPath, session.remotePath)
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.logHistory(config, session, serverName, document, 'failed', message);
      throw err; // handleSave shows the visible error
    }

    await this.refreshSessionBaseline(document, session);
    vscode.window.setStatusBarMessage(`$(check) Uploaded ${fileName} → ${serverName}`, 3000);
    await this.logHistory(config, session, serverName, document, 'success');
  }

  private async checkForConflict(
    document: vscode.TextDocument,
    session: RemoteEditSession,
    serverName: string,
    fileName: string
  ): Promise<ConflictCheckResult> {
    const { connection } = this.dependencies;

    // Fail closed (D4): an unreadable mtime is a suspected conflict, never
    // "no conflict". Precedent: the v0.9.0 NaN-mtime bug silently disabled
    // the file-date guard. NaN never compares equal, so it lands on the
    // suspected path below.
    let remoteStat: { mtime: Date } | null = null;
    let statFailed = false;
    try {
      remoteStat = await connection.statRemote(session.remotePath);
    } catch {
      statFailed = true;
    }

    if (!statFailed && remoteStat === null) {
      const choice = await vscode.window.showWarningMessage(
        `${fileName} was deleted on "${serverName}" since you opened it.`,
        {
          modal: true,
          detail: `Uploading will recreate it. Your edits are saved locally at ${document.uri.fsPath}.`,
        },
        'Upload Anyway'
      );
      return choice === 'Upload Anyway'
        ? { outcome: 'proceed', remoteExists: false }
        : { outcome: 'cancelled', remoteExists: false };
    }

    const remoteMtimeMs = remoteStat ? remoteStat.mtime.getTime() : Number.NaN;

    // Both timestamps are readings of the SAME remote clock, so the server's
    // skew (timeOffsetMs) cancels out of the comparison. Any difference is
    // suspicious — including mtime moving backwards: a restored backup is
    // still someone else's change.
    //
    // Known gaps, accepted for v1:
    //  - FTP mtime (MDTM) is second-granular, a weaker guarantee than SFTP:
    //    an edit landing in the same second as the baseline is invisible to
    //    the mtime check (the sha256 check below still catches it whenever
    //    anything DID move the mtime).
    //  - A remote edit that preserves mtime exactly (rsync -t, a restore that
    //    resets timestamps) is invisible entirely; catching it would cost a
    //    full download on every save.
    if (!statFailed && remoteMtimeMs === session.downloadedMtimeMs) {
      return { outcome: 'proceed', remoteExists: true };
    }

    // Suspected conflict — confirm against the content before prompting: a
    // merely-touched file (same bytes, new mtime) uploads without a prompt.
    // This is also what keeps FTP's coarse mtime workable.
    let remoteBytes: Buffer | undefined;
    try {
      remoteBytes = await connection.downloadFile(session.remotePath);
      const remoteSha256 = crypto.createHash('sha256').update(remoteBytes).digest('hex');
      if (remoteSha256 === session.sha256) {
        return { outcome: 'proceed', remoteExists: true, remoteBytes };
      }
    } catch {
      // content unreadable too — prompt without a diff option
    }

    const message = statFailed || Number.isNaN(remoteMtimeMs)
      ? `Could not verify whether ${fileName} changed on "${serverName}" since you opened it.`
      : `${fileName} changed on "${serverName}" since you opened it (remote modified ${remoteStat!.mtime.toISOString()}).`;
    const choices = remoteBytes ? ['Overwrite', 'Show Diff'] : ['Overwrite'];

    const choice = await vscode.window.showWarningMessage(
      message,
      {
        modal: true,
        detail: `Overwriting will discard that change. Your edits are saved locally at ${document.uri.fsPath}.`,
      },
      ...choices
    );

    const remoteExists = remoteBytes !== undefined || !statFailed;
    if (choice === 'Overwrite') {
      return { outcome: 'proceed', remoteExists, remoteBytes };
    }
    if (choice === 'Show Diff' && remoteBytes) {
      await this.showConflictDiff(document, remoteBytes, serverName, fileName);
      return { outcome: 'diff-shown', remoteExists, remoteBytes };
    }
    return { outcome: 'cancelled', remoteExists, remoteBytes };
  }

  private async showConflictDiff(
    document: vscode.TextDocument,
    remoteBytes: Buffer,
    serverName: string,
    fileName: string
  ): Promise<void> {
    const extension = path.extname(document.uri.fsPath);
    const conflictTempPath = path.join(
      path.dirname(document.uri.fsPath),
      `${path.basename(document.uri.fsPath, extension)}.conflict${extension}`
    );
    await fs.writeFile(conflictTempPath, remoteBytes);
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(conflictTempPath),
      document.uri,
      `${fileName}: on "${serverName}" ↔ your edits`
    );
  }

  private async refreshSessionBaseline(
    document: vscode.TextDocument,
    session: RemoteEditSession
  ): Promise<void> {
    // The remote now holds this save's bytes, so BOTH baselines must move: a
    // stale sha256 would flag the next merely-touched save as a conflict
    // (the hash check would compare the remote against pre-edit content).
    let downloadedMtimeMs = Number.NaN; // NaN fails closed; the hash check rescues
    try {
      const remoteStat = await this.dependencies.connection.statRemote(session.remotePath);
      if (remoteStat) {
        downloadedMtimeMs = remoteStat.mtime.getTime();
      }
    } catch {
      // keep NaN
    }

    let sha256 = ''; // never matches — fails closed
    try {
      const savedBytes = await fs.readFile(document.uri.fsPath);
      sha256 = crypto.createHash('sha256').update(savedBytes).digest('hex');
    } catch {
      // keep ''
    }

    this.dependencies.registry.register(document.uri.fsPath, {
      ...session,
      downloadedMtimeMs,
      sha256,
    });
  }

  private async logHistory(
    config: ProjectConfig,
    session: RemoteEditSession,
    serverName: string,
    document: vscode.TextDocument,
    result: UploadHistoryEntry['result'],
    error?: string
  ): Promise<void> {
    // Best-effort: a history failure must never mask a completed upload.
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const historyMaxEntries = config.historyMaxEntries ?? 10000;
      if (!workspaceRoot || historyMaxEntries <= 0) {
        return;
      }
      const historyService = new UploadHistoryService(workspaceRoot, historyMaxEntries);
      await historyService.log([{
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        serverId: session.serverId,
        serverName,
        localPath: document.uri.fsPath,
        remotePath: session.remotePath,
        action: 'upload',
        result,
        ...(error !== undefined ? { error } : {}),
        trigger: 'remote-edit',
      }]);
      await historyService.enforceRetention();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.dependencies.output.appendLine(`[remote-edit] Failed to write upload history: ${message}`);
    }
  }
}
