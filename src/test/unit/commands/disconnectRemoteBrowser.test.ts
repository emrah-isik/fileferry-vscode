import * as vscode from 'vscode';
import { disconnectRemoteBrowser } from '../../../commands/disconnectRemoteBrowser';

// 18a-2b, Q25/R6: Disconnect Remote Browser also drains the jump-host pool —
// idle hops close now, held hops close on their last release. It must never
// cut a hop under a live deploy or terminal, which is exactly drain()'s
// contract (tested in JumpHostPool.test.ts); here we verify the wiring.
describe('disconnectRemoteBrowser', () => {
  it('suspends the panel first, then drains the pool', async () => {
    const calls: string[] = [];
    const browserProvider = { suspend: jest.fn(async () => { calls.push('suspend'); }) };
    const pool = { drain: jest.fn(() => { calls.push('drain'); }) };

    await disconnectRemoteBrowser(browserProvider, pool);

    // Suspend releases the panel's own hop leases before the drain, so the
    // panel's hops count as idle and close immediately.
    expect(calls).toEqual(['suspend', 'drain']);
  });

  it('reports the disconnect to the user', async () => {
    const browserProvider = { suspend: jest.fn().mockResolvedValue(undefined) };
    const pool = { drain: jest.fn() };

    await disconnectRemoteBrowser(browserProvider, pool);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('disconnected')
    );
  });
});
