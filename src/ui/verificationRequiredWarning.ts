import * as vscode from 'vscode';

/**
 * The shared fail-fast warning for background connects (18a-1b, Q32/H2).
 *
 * Background triggers (upload-on-save, the file watcher, autosave-driven
 * remote-edit saves) connect with `interactive: false` and receive a typed
 * `InteractionRequiredError` when the host is not yet trusted or
 * authentication would need prompts. This non-modal warning tells the user
 * how to unblock: verify the host once interactively.
 *
 * @param detail Optional caller-specific tail (e.g. where unsaved edits live).
 */
export function showVerificationRequiredWarning(serverName: string, serverId: string, detail?: string): void {
  const message =
    `FileFerry: "${serverName}" — host not yet trusted or verification required, so the background upload was skipped. ` +
    `Run Test Connection or deploy manually once to verify it.${detail ? ` ${detail}` : ''}`;
  void Promise.resolve(vscode.window.showWarningMessage(message, 'Test Connection')).then(choice => {
    if (choice === 'Test Connection') {
      void vscode.commands.executeCommand('fileferry.servers.testConnection', serverId);
    }
  });
}
