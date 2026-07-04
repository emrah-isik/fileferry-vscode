import * as vscode from 'vscode';
import { ProjectServer } from './models/ProjectConfig';

type ServerHooks = ProjectServer['hooks'];

// UploadConfirmation shows a dialog before each upload to prevent accidental deploys.
// Suppression is stored per-server in VSCode's globalState (persists across sessions).
//
// When a deploy has hooks, the full command list is written to the FileFerry output
// channel (a plain notification can't render a multi-line list, and a native modal
// is jarring/plays a sound), and the quiet in-theme toast points the user to it.
//
// showMessage / showModalWarning are injected so tests can drive them without VSCode.
export class UploadConfirmation {
  constructor(
    private globalState: vscode.Memento,
    private output?: vscode.OutputChannel,
    private showMessage: (
      message: string,
      ...items: string[]
    ) => Thenable<string | undefined> = vscode.window.showInformationMessage.bind(vscode.window),
    // Only the irreversible sync-delete confirmation uses a true modal warning —
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
    const key = `fileferry.confirm.suppress.${serverId}`;
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
    const question = `Upload ${label} to "${displayName}"?`;

    if (hasHooks) {
      this.logHooks(hookLines);
      const result = await this.showMessage(
        `${question} ${hookCountLabel(hookLines.length)} will run — see the FileFerry output.`,
        'Upload',
        'Cancel'
      );
      return result === 'Upload';
    }

    const result = await this.showMessage(
      question,
      'Upload',
      "Upload, don't ask again",
      'Cancel'
    );

    if (result === "Upload, don't ask again") {
      await this.globalState.update(key, true);
      return true;
    }

    return result === 'Upload';
  }

  // Shows a confirmation dialog when the deploy includes file deletions.
  // Deletions are irreversible, so suppression is never applied and
  // "don't ask again" is not offered.
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
    const question = `Deploy to "${serverName}": ${parts.join(' and ')}?`;
    const hookLines = describeHooks(hooks);
    if (hookLines.length > 0) {
      this.logHooks(hookLines);
      const result = await this.showMessage(
        `${question} ${hookCountLabel(hookLines.length)} will run — see the FileFerry output.`,
        'Proceed',
        'Cancel'
      );
      return result === 'Proceed';
    }
    const result = await this.showMessage(question, 'Proceed', 'Cancel');
    return result === 'Proceed';
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
    // Modal warning (not the dismissable toast) — a destructive, irreversible
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
    const result = await this.showMessage(
      `This deploy will run hook commands on ${serverCount} server(s) — see the FileFerry output.`,
      'Proceed',
      'Cancel'
    );
    return result === 'Proceed';
  }

  // Clears "don't ask again" for all servers — called by the reset command.
  async resetAll(serverIds: string[]): Promise<void> {
    for (const id of serverIds) {
      await this.globalState.update(`fileferry.confirm.suppress.${id}`, false);
    }
  }

  // Writes the hook list to the output channel and reveals it (without stealing
  // focus), so the commands are visible when the confirmation toast appears.
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

// Renders one bullet line per hook command, tagged with its phase and location,
// e.g. `• [pre · local] npm run build`. Commands are shown UNRESOLVED — the
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
