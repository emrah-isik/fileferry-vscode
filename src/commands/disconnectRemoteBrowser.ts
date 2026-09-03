import * as vscode from 'vscode';
import { RemoteBrowserProvider } from '../remoteBrowser/RemoteBrowserProvider';
import { JumpHostPool } from '../ssh/JumpHostPool';

/**
 * "FileFerry: Disconnect Remote Browser" (18a-2b, Q25/R6). Suspends the panel
 * (its own session releases its hop leases), then drains the jump-host pool:
 * idle hops close now, held hops are marked close-on-last-release — a hop
 * under a live deploy or terminal is never cut. Deliberately NOT a separate
 * "Disconnect All" command (rejected in Q25).
 */
export async function disconnectRemoteBrowser(
  browserProvider: Pick<RemoteBrowserProvider, 'suspend'>,
  pool: Pick<JumpHostPool, 'drain'>
): Promise<void> {
  await browserProvider.suspend();
  pool.drain();
  vscode.window.showInformationMessage('FileFerry: Remote browser disconnected.');
}
