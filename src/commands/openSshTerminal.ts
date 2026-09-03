import * as vscode from 'vscode';
import { SshCredential } from '../models/SshCredential';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { SshTerminal, SshTerminalDependencies } from '../terminal/SshTerminal';

/**
 * Open SSH Terminal (feature 20, Q11) — one core behind three entry points:
 * the Command Palette (active server, cwd = its root path), the Servers tree
 * (that server, its root path), and the Remote Files panel (active server,
 * the clicked or currently listed directory). SFTP only: FTP/FTPS have no
 * shell to open. The tab opens at once; the dial (and any prompts) happens
 * inside the pseudoterminal.
 */

export interface OpenSshTerminalDependencies {
  configManager: Pick<ProjectConfigManager, 'getConfig' | 'getServerById'>;
  credentialManager: Pick<CredentialManager, 'getAll' | 'getWithSecret'>;
  terminal: SshTerminalDependencies;
}

export interface OpenSshTerminalSelection {
  /** `null` = the project's active (default) server. */
  serverId: string | null;
  /** Directory the shell starts in; defaults to the server's root path. */
  remotePath?: string;
}

type RouteStop = Pick<SshCredential, 'username' | 'host' | 'port'>;

/** `local → hop… → target`; a hop whose credential was deleted is named as such (mirrors the Servers tooltip). */
export function describeRoute(hops: Array<RouteStop | undefined>, target: RouteStop): string {
  const stops = hops.map((hop) => (hop ? `${hop.username}@${hop.host}:${hop.port}` : '(missing jump host)'));
  stops.push(`${target.username}@${target.host}:${target.port}`);
  return `local → ${stops.join(' → ')}`;
}

export async function openSshTerminal(
  selection: OpenSshTerminalSelection,
  dependencies: OpenSshTerminalDependencies
): Promise<void> {
  let serverId = selection.serverId;
  if (!serverId) {
    const config = await dependencies.configManager.getConfig();
    serverId = config?.defaultServerId ?? null;
    if (!serverId) {
      vscode.window.showErrorMessage('FileFerry: No server configured. Open Deployment Settings to add one.');
      return;
    }
  }

  const entry = await dependencies.configManager.getServerById(serverId);
  if (!entry) {
    vscode.window.showErrorMessage('FileFerry: Server not found. It may have been deleted.');
    return;
  }
  const { name: serverName, server } = entry;

  if (server.type !== 'sftp') {
    vscode.window.showErrorMessage(
      `FileFerry: Open SSH Terminal needs an SFTP server — "${serverName}" uses ${server.type.toUpperCase()}.`
    );
    return;
  }

  const credentials = await dependencies.credentialManager.getAll();
  const credential = credentials.find((candidate) => candidate.id === server.credentialId);
  if (!credential) {
    vscode.window.showErrorMessage(`FileFerry: The credential for "${serverName}" no longer exists — pick another in Deployment Settings.`);
    return;
  }
  const hops = (credential.jumpHosts ?? []).map((hopId) => credentials.find((candidate) => candidate.id === hopId));
  const remotePath = selection.remotePath ?? server.rootPath;

  const pty = new SshTerminal(
    {
      serverName,
      remotePath,
      route: describeRoute(hops, credential),
      resolveCredential: () => dependencies.credentialManager.getWithSecret(server.credentialId),
    },
    dependencies.terminal
  );
  const terminal = vscode.window.createTerminal({ name: `FileFerry: ${serverName} — ${remotePath}`, pty });
  terminal.show();
}
