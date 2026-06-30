import * as vscode from 'vscode';
import { ProjectServer } from './models/ProjectConfig';

type ServerHooks = ProjectServer['hooks'];

// UploadConfirmation shows a dialog before each upload to prevent accidental deploys.
// Suppression is stored per-server in VSCode's globalState (persists across sessions).
//
// The showMessage function is injected so tests can mock it without needing VSCode running.

export class UploadConfirmation {
  constructor(
    private globalState: vscode.Memento,
    private showMessage: (
      message: string,
      ...items: string[]
    ) => Thenable<string | undefined> = vscode.window.showInformationMessage.bind(vscode.window),
    // Destructive confirmations (irreversible deletes) use a true modal warning so
    // they can't be missed or auto-dismissed like the ordinary info toast above.
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
    const message = hasHooks
      ? `Upload ${label} to "${displayName}"?\n\n${hookListSection(hookLines)}`
      : `Upload ${label} to "${displayName}"?`;

    if (hasHooks) {
      const result = await this.showMessage(message, 'Upload', 'Cancel');
      return result === 'Upload';
    }

    const result = await this.showMessage(
      message,
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
    const summary = parts.join(' and ');
    const hookLines = describeHooks(hooks);
    const message = hookLines.length > 0
      ? `Deploy to "${serverName}": ${summary}?\n\n${hookListSection(hookLines)}`
      : `Deploy to "${serverName}": ${summary}?`;
    const result = await this.showMessage(message, 'Proceed', 'Cancel');
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
    const hookSuffix = hookLines.length > 0 ? `\n\n${hookListSection(hookLines)}` : '';
    // Modal warning (not the dismissable info toast) — a destructive, irreversible
    // delete must force a deliberate choice. The modal supplies its own Cancel.
    const result = await this.showModalWarning(
      `Sync to "${serverName}" will upload ${uploadLabel} and DELETE ${deleteLabel} not present locally. ` +
        `Deleted files cannot be recovered.${hookSuffix}`,
      'Sync and Delete'
    );
    return result === 'Sync and Delete';
  }

  // Multi-server deploys (uploadToServers) pick servers via a QuickPick and have
  // no per-file confirmation, so hooks would otherwise run unseen. When any
  // selected server has hooks, show a modal listing them grouped by server so the
  // visible-in-confirmation rule still holds. Returns true (without prompting)
  // when no server has hooks.
  async confirmHooks(entries: Array<{ serverName: string; hooks: ServerHooks }>): Promise<boolean> {
    const sections: string[] = [];
    for (const entry of entries) {
      const hookLines = describeHooks(entry.hooks);
      if (hookLines.length > 0) {
        sections.push(`${entry.serverName}:\n${hookLines.join('\n')}`);
      }
    }
    if (sections.length === 0) {
      return true;
    }
    const result = await this.showModalWarning(
      `These commands will run on this deploy:\n\n${sections.join('\n\n')}`,
      'Proceed'
    );
    return result === 'Proceed';
  }

  // Clears "don't ask again" for all servers — called by the reset command.
  async resetAll(serverIds: string[]): Promise<void> {
    for (const id of serverIds) {
      await this.globalState.update(`fileferry.confirm.suppress.${id}`, false);
    }
  }
}

// Renders one bullet line per hook command, tagged with its phase and location,
// e.g. `  • [pre · local] npm run build`. Commands are shown UNRESOLVED — the
// literal string from config ($VAR / ${secret:…}), since resolution happens at
// run time, so the dialog never displays a secret value.
function describeHooks(hooks?: ServerHooks): string[] {
  if (!hooks) {
    return [];
  }
  const lines: string[] = [];
  for (const hook of hooks.preDeploy ?? []) {
    lines.push(`  • [pre · ${hook.location}] ${hook.command}`);
  }
  for (const hook of hooks.postDeploy ?? []) {
    lines.push(`  • [post · ${hook.location}] ${hook.command}`);
  }
  return lines;
}

function hookListSection(hookLines: string[]): string {
  return `These commands will also run on this deploy:\n${hookLines.join('\n')}`;
}
