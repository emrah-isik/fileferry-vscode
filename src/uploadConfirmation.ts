import * as vscode from 'vscode';

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
    ) => Thenable<string | undefined> = vscode.window.showInformationMessage.bind(vscode.window)
  ) {}

  async confirm(serverId: string, fileCount: number, serverName?: string): Promise<boolean> {
    const key = `fileferry.confirm.suppress.${serverId}`;
    const suppressed = this.globalState.get<boolean>(key, false);

    if (suppressed) {
      return true;
    }

    const label = fileCount === 1 ? '1 file' : `${fileCount} files`;
    const displayName = serverName ?? serverId;
    const result = await this.showMessage(
      `Upload ${label} to "${displayName}"?`,
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
    deleteCount: number
  ): Promise<boolean> {
    const parts: string[] = [];
    if (uploadCount > 0) {
      parts.push(`upload ${uploadCount} ${uploadCount === 1 ? 'file' : 'files'}`);
    }
    if (deleteCount > 0) {
      parts.push(`delete ${deleteCount} ${deleteCount === 1 ? 'file' : 'files'}`);
    }
    const summary = parts.join(' and ');
    const result = await this.showMessage(
      `Deploy to "${serverName}": ${summary}?`,
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
}
