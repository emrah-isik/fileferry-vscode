import * as vscode from 'vscode';
import { copyRemotePath } from '../../../commands/copyRemotePath';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

describe('copyRemotePath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('copies the remote path to clipboard', async () => {
    const entry: RemoteEntry = {
      name: 'app.log',
      type: '-',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/www/logs/app.log',
    };
    const item = new RemoteFileItem(entry);

    await copyRemotePath(item);

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('/var/www/logs/app.log');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Copied: /var/www/logs/app.log');
  });

  it('copies directory paths', async () => {
    const entry: RemoteEntry = {
      name: 'logs',
      type: 'd',
      size: 4096,
      modifyTime: 1710000000000,
      remotePath: '/var/www/logs',
    };
    const item = new RemoteFileItem(entry);

    await copyRemotePath(item);

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('/var/www/logs');
  });

  it('does nothing when item has no entry', async () => {
    await copyRemotePath(undefined);

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });
});
