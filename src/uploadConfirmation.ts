import * as vscode from 'vscode';
import { ProjectServer } from './models/ProjectConfig';

type ServerHooks = ProjectServer['hooks'];

const SUPPRESS_KEY_PREFIX = 'fileferry.confirm.suppress.';

// One row of the confirmation pick. `action` is what the row does; `label` is
// what the user reads (and what tests assert against).
export interface ConfirmationChoice extends vscode.QuickPickItem {
  action: 'confirm' | 'confirm-and-suppress' | 'cancel';
}

export type ShowConfirmationPick = (
  title: string,
  items: ConfirmationChoice[]
) => Thenable<ConfirmationChoice | undefined>;

// UploadConfirmation asks before each upload to prevent accidental deploys.
// Suppression is stored per-server in VSCode's globalState (persists across sessions).
//
// Feature 36: the prompt is a QuickPick, not a notification toast. A toast never
// takes keyboard focus, so Enter went to the editor and the buttons needed the
// mouse (found in the 2026-09-15 Cursor pass). The pick takes focus at once:
// Enter on the first row confirms, Escape (or clicking elsewhere) cancels, and it
// stays quiet and in-theme (a native modal is jarring and plays a sound). Only the
// irreversible sync-delete confirmation uses a true modal warning.
//
// When a deploy has hooks, the full command list is written to the FileFerry
// output channel (a pick row can't render a multi-line list), and the confirming
// row's detail names the count and points the user to it.
//
// showPick / showModalWarning are injected so tests can drive them without VSCode.
export class UploadConfirmation {
  constructor(
    private globalState: vscode.Memento,
    private output?: vscode.OutputChannel,
    private showPick: ShowConfirmationPick = (title, items) =>
      vscode.window.showQuickPick(items, {
        title,
        placeHolder: 'Enter confirms, Escape cancels',
        ignoreFocusOut: false,
      }),
    // Only the irreversible sync-delete confirmation uses a true modal warning:
    // a destructive, unrecoverable action warrants forcing a deliberate choice.
    private showModalWarning: (
      message: string,
      ...items: string[]
    ) => Thenable<string | undefined> = (message, ...items) =>
      vscode.window.showWarningMessage(message, { modal: true }, ...items)
  ) {}

  async confirm(serverId: string, fileCount: number, serverName?: string, hooks?: ServerHooks): Promise<boolean> {
    const hookLines = describeHooks(hooks);
    const hasHooks = hookLines.length > 0;
    const key = `${SUPPRESS_KEY_PREFIX}${serverId}`;
    const suppressed = this.globalState.get<boolean>(key, false);

    // Suppression must never hide hooks: a deploy that runs shell commands is
    // always shown (and "don't ask again" isn't offered), so a teammate's
    // surprise hook can't run unseen. The trust gate is the first guard; this
    // visible-in-confirmation rule is the second.
    if (suppressed && !hasHooks) {
      return true;
    }

    const label = fileCount === 1 ? '1 file' : `${fileCount} files`;
    const displayName = serverName ?? serverId;
    const title = `Upload ${label} to "${displayName}"?`;

    if (hasHooks) {
      this.logHooks(hookLines);
      const choice = await this.showPick(title, [
        { label: 'Upload', detail: hookDetail(hookLines.length), action: 'confirm' },
        cancelChoice(),
      ]);
      return choice?.action === 'confirm';
    }

    const choice = await this.showPick(title, [
      { label: 'Upload', detail: `Upload ${label} now`, action: 'confirm' },
      {
        label: "Upload, don't ask again",
        detail: `Skips this prompt for "${displayName}" until you run FileFerry: Reset Upload Confirmations`,
        action: 'confirm-and-suppress',
      },
      cancelChoice(),
    ]);

    if (choice?.action === 'confirm-and-suppress') {
      await this.globalState.update(key, true);
      return true;
    }

    return choice?.action === 'confirm';
  }

  // Confirmation when the deploy includes file deletions. Deletions are
  // irreversible, so suppression is never applied and "don't ask again" is not
  // offered.
  async confirmWithDeletions(
    serverName: string,
    uploadCount: number,
    deleteCount: number,
    hooks?: ServerHooks
  ): Promise<boolean> {
    const parts: string[] = [];
    if (uploadCount > 0) {
      parts.push(`upload ${uploadCount} ${uploadCount === 1 ? 'file' : 'files'}`);
    }
    if (deleteCount > 0) {
      parts.push(`delete ${deleteCount} ${deleteCount === 1 ? 'file' : 'files'}`);
    }
    const title = `Deploy to "${serverName}": ${parts.join(' and ')}?`;
    const hookLines = describeHooks(hooks);
    if (hookLines.length > 0) {
      this.logHooks(hookLines);
    }
    const proceedDetail = hookLines.length > 0
      ? hookDetail(hookLines.length)
      : 'Deleted files are removed from the server';
    const choice = await this.showPick(title, [
      { label: 'Proceed', detail: proceedDetail, action: 'confirm' },
      cancelChoice(),
    ]);
    return choice?.action === 'confirm';
  }

  // Confirmation for Sync to Remote when delete-extras will prune remote files.
  // Deletes are irreversible, so this is never suppressed, never offers
  // "don't ask again", and names the exact count being deleted (safety #3).
  async confirmSyncDeletions(
    serverName: string,
    uploadCount: number,
    deleteCount: number,
    hooks?: ServerHooks
  ): Promise<boolean> {
    const uploadLabel = uploadCount === 1 ? '1 file' : `${uploadCount} files`;
    const deleteLabel = deleteCount === 1 ? '1 remote file' : `${deleteCount} remote files`;
    const hookLines = describeHooks(hooks);
    if (hookLines.length > 0) {
      this.logHooks(hookLines);
    }
    const hookNote = hookLines.length > 0
      ? ` ${hookCountLabel(hookLines.length)} will also run (see the FileFerry output).`
      : '';
    // Modal warning (not the dismissable pick): a destructive, irreversible
    // delete must force a deliberate choice. The modal supplies its own Cancel.
    const result = await this.showModalWarning(
      `Sync to "${serverName}" will upload ${uploadLabel} and DELETE ${deleteLabel} not present locally. ` +
        `Deleted files cannot be recovered.${hookNote}`,
      'Sync and Delete'
    );
    return result === 'Sync and Delete';
  }

  // Multi-server deploys (uploadToServers) pick servers via a QuickPick and have
  // no per-file confirmation, so hooks would otherwise run unseen. When any
  // selected server has hooks, list them (grouped by server) in the output and
  // confirm. Returns true (without prompting) when no server has hooks.
  async confirmHooks(entries: Array<{ serverName: string; hooks: ServerHooks }>): Promise<boolean> {
    const lines: string[] = [];
    let serverCount = 0;
    for (const entry of entries) {
      const hookLines = describeHooks(entry.hooks);
      if (hookLines.length > 0) {
        serverCount++;
        lines.push(`${entry.serverName}:`, ...hookLines.map(line => `  ${line}`));
      }
    }
    if (lines.length === 0) {
      return true;
    }
    this.logHooks(lines);
    const choice = await this.showPick(
      `This deploy will run hook commands on ${serverCount} server(s). Continue?`,
      [
        { label: 'Proceed', detail: 'The commands are listed in the FileFerry output', action: 'confirm' },
        cancelChoice(),
      ]
    );
    return choice?.action === 'confirm';
  }

  // File date guard (36b): some files to upload are older than their remote
  // copies. Never suppressed, never offers "don't ask again": overwriting
  // someone else's newer change is the thing the guard exists to catch.
  async confirmOverwriteNewer(serverName: string | undefined, fileNames: string[]): Promise<boolean> {
    const where = serverName ? `"${serverName}"` : 'the remote';
    const title = fileNames.length === 1
      ? `1 file is newer on ${where}. Overwrite it?`
      : `${fileNames.length} files are newer on ${where}. Overwrite them?`;
    const choice = await this.showPick(title, [
      { label: 'Overwrite', detail: `Replace with your local copy: ${fileNames.join(', ')}`, action: 'confirm' },
      cancelChoice(),
    ]);
    return choice?.action === 'confirm';
  }

  // Force upload (36b): the file matches an excluded path pattern.
  async confirmUploadExcluded(localPath: string): Promise<boolean> {
    const fileName = localPath.split(/[\\/]/).pop() ?? localPath;
    const choice = await this.showPick(`${fileName} matches an excluded path. Upload it anyway?`, [
      { label: 'Upload anyway', detail: `Ignore the excluded-path patterns for ${localPath} this once`, action: 'confirm' },
      cancelChoice(),
    ]);
    return choice?.action === 'confirm';
  }

  // Clears "don't ask again". With a server list, clears those; without one
  // (the reset command), sweeps every stored suppression key, so servers that
  // were deleted or belong to another project are cleared too. Returns the
  // number of servers cleared.
  async resetAll(serverIds?: string[]): Promise<number> {
    const keys = serverIds
      ? serverIds.map(id => `${SUPPRESS_KEY_PREFIX}${id}`)
      : this.globalState.keys().filter(key => key.startsWith(SUPPRESS_KEY_PREFIX));
    for (const key of keys) {
      await this.globalState.update(key, false);
    }
    return keys.length;
  }

  // Writes the hook list to the output channel and reveals it (without stealing
  // focus), so the commands are visible when the confirmation pick appears.
  private logHooks(lines: string[]): void {
    if (!this.output) {
      return;
    }
    this.output.appendLine('FileFerry: these commands will run on this deploy:');
    for (const line of lines) {
      this.output.appendLine(`  ${line}`);
    }
    this.output.show(true);
  }
}

function cancelChoice(): ConfirmationChoice {
  return { label: 'Cancel', detail: 'Nothing is uploaded (Escape does the same)', action: 'cancel' };
}

function hookDetail(hookCount: number): string {
  return `${hookCountLabel(hookCount)} will run, listed in the FileFerry output`;
}

// Renders one bullet line per hook command, tagged with its phase and location,
// e.g. `• [pre · local] npm run build`. Commands are shown UNRESOLVED: the
// literal string from config ($VAR / ${secret:…}), since resolution happens at
// run time, so nothing ever displays a secret value.
function describeHooks(hooks?: ServerHooks): string[] {
  if (!hooks) {
    return [];
  }
  const lines: string[] = [];
  for (const hook of hooks.preDeploy ?? []) {
    lines.push(`• [pre · ${hook.location}] ${hook.command}`);
  }
  for (const hook of hooks.postDeploy ?? []) {
    lines.push(`• [post · ${hook.location}] ${hook.command}`);
  }
  return lines;
}

function hookCountLabel(count: number): string {
  return `${count} hook${count === 1 ? '' : 's'}`;
}
