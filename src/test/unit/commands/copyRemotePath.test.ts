import * as vscode from 'vscode';
import { copyRemotePath } from '../../../commands/copyRemotePath';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

function makeItem(overrides: Partial<RemoteEntry> & { name: string; remotePath: string }): RemoteFileItem {
  const entry: RemoteEntry = {
    type: '-',
    size: 1024,
    modifyTime: 1710000000000,
    ...overrides,
  };
  return new RemoteFileItem(entry);
}

describe('copyRemotePath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('copies the remote path to clipboard', async () => {
    const item = makeItem({ name: 'app.log', remotePath: '/var/www/logs/app.log' });

    await copyRemotePath([item]);

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('/var/www/logs/app.log');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Copied: /var/www/logs/app.log');
  });

  it('copies directory paths', async () => {
    const item = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });

    await copyRemotePath([item]);

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('/var/www/logs');
  });

  it('joins several selected paths with newlines, in selection order', async () => {
    const firstItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
    const directoryItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });
    const secondItem = makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });

    await copyRemotePath([firstItem, directoryItem, secondItem]);

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      '/var/www/a.txt\n/var/www/logs\n/var/www/b.txt'
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Copied 3 remote paths');
  });

  it('does nothing when the target list is empty', async () => {
    await copyRemotePath([]);

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
