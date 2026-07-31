import { chmodRemoteItem } from '../../../commands/chmodRemoteItem';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

const vscode = require('vscode');

const mockConnection = {
  chmod: jest.fn(),
};

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
};

const mockOutput = { appendLine: jest.fn() };
const mockRefresh = jest.fn();

const server = {
  id: 'server-1', type: 'sftp' as const,
  credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/var/www', mappings: [], excludedPaths: [],
};
const baseConfig = { defaultServerId: 'server-1', servers: { Production: server }, dryRun: false };

function makeItem(overrides: Partial<RemoteEntry> & { name: string; remotePath: string }): RemoteFileItem {
  const entry: RemoteEntry = {
    type: '-',
    size: 1024,
    modifyTime: 1710000000000,
    ...overrides,
  };
  return new RemoteFileItem(entry);
}

describe('chmodRemoteItem', () => {
  function dependencies() {
    return {
      connection: mockConnection as any,
      configManager: mockConfigManager as any,
      output: mockOutput as any,
      refresh: mockRefresh,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();

    vscode.window.showInputBox.mockResolvedValue('644');
    vscode.window.withProgress.mockImplementation(
      (_options: any, task: (progress: any) => Promise<any>) => task({ report: jest.fn() })
    );
    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server });
    mockConnection.chmod.mockResolvedValue(undefined);
  });

  it('does nothing when the target list is empty', async () => {
    await chmodRemoteItem([], dependencies());

    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(mockConnection.chmod).not.toHaveBeenCalled();
  });

  it('does nothing when the mode prompt is cancelled', async () => {
    vscode.window.showInputBox.mockResolvedValue(undefined);
    const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

    await chmodRemoteItem([item], dependencies());

    expect(mockConnection.chmod).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('wires the octal validator into the input box', async () => {
    const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

    await chmodRemoteItem([item], dependencies());

    const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
    expect(inputBoxOptions.validateInput('644')).toBeFalsy();
    expect(inputBoxOptions.validateInput('2775')).toBeFalsy();
    expect(inputBoxOptions.validateInput('888')).toBeTruthy();
    expect(inputBoxOptions.validateInput('u+x')).toBeTruthy();
    expect(inputBoxOptions.placeHolder).toContain('644');
  });

  it('applies the parsed octal mode and confirms in the status bar', async () => {
    const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

    await chmodRemoteItem([item], dependencies());

    expect(mockConnection.chmod).toHaveBeenCalledWith('/var/www/index.php', 0o644);
    expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining('$(check)'),
      expect.any(Number)
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('trims the entered mode before parsing', async () => {
    vscode.window.showInputBox.mockResolvedValue('  755  ');
    const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

    await chmodRemoteItem([item], dependencies());

    expect(mockConnection.chmod).toHaveBeenCalledWith('/var/www/index.php', 0o755);
  });

  it('supports 4-digit modes (setgid etc.)', async () => {
    vscode.window.showInputBox.mockResolvedValue('2775');
    const item = makeItem({ name: 'shared', type: 'd', size: 4096, remotePath: '/var/www/shared' });

    await chmodRemoteItem([item], dependencies());

    expect(mockConnection.chmod).toHaveBeenCalledWith('/var/www/shared', 0o2775);
  });

  it('shows the error and does not refresh when the chmod fails', async () => {
    mockConnection.chmod.mockRejectedValue(new Error('502 Command not implemented'));
    const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

    await chmodRemoteItem([item], dependencies());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('502 Command not implemented')
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('honours dry run: logs the plan per target, touches nothing', async () => {
    mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });
    const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
    const directoryItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });

    await chmodRemoteItem([fileItem, directoryItem], dependencies());

    expect(mockOutput.appendLine).toHaveBeenCalledWith(
      '[remote-chmod] DRY RUN — would chmod 644 /var/www/a.txt (Production)'
    );
    expect(mockOutput.appendLine).toHaveBeenCalledWith(
      '[remote-chmod] DRY RUN — would chmod 644 /var/www/logs (Production)'
    );
    expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining('$(beaker)'),
      expect.any(Number)
    );
    expect(mockConnection.chmod).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  describe('multiple targets', () => {
    it('prompts ONCE and applies the same mode to every target sequentially', async () => {
      vscode.window.showInputBox.mockResolvedValue('755');
      const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
      const directoryItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });

      await chmodRemoteItem([fileItem, directoryItem], dependencies());

      expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
      expect(mockConnection.chmod).toHaveBeenCalledWith('/var/www/a.txt', 0o755);
      expect(mockConnection.chmod).toHaveBeenCalledWith('/var/www/logs', 0o755);
      const progressOptions = vscode.window.withProgress.mock.calls[0][0];
      expect(progressOptions.location).toBe(vscode.ProgressLocation.Notification);
      expect(progressOptions.title).toContain('2');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('does NOT drop a selected child of a selected folder — chmod is non-recursive', async () => {
      const directoryItem = makeItem({ name: 'logs', type: 'd', size: 4096, remotePath: '/var/www/logs' });
      const childItem = makeItem({ name: 'app.log', remotePath: '/var/www/logs/app.log' });

      await chmodRemoteItem([directoryItem, childItem], dependencies());

      expect(mockConnection.chmod).toHaveBeenCalledWith('/var/www/logs', 0o644);
      expect(mockConnection.chmod).toHaveBeenCalledWith('/var/www/logs/app.log', 0o644);
    });

    it('continues past a failure, aggregates it, and still refreshes once', async () => {
      mockConnection.chmod
        .mockRejectedValueOnce(new Error('Permission denied'))
        .mockResolvedValue(undefined);
      const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
      const otherItem = makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });

      await chmodRemoteItem([fileItem, otherItem], dependencies());

      expect(mockConnection.chmod).toHaveBeenCalledWith('/var/www/b.txt', 0o644);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('a.txt')
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('does not refresh when every chmod failed', async () => {
      mockConnection.chmod.mockRejectedValue(new Error('502 Command not implemented'));
      const fileItem = makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
      const otherItem = makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });

      await chmodRemoteItem([fileItem, otherItem], dependencies());

      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('configuration errors', () => {
    it('errors when no server is configured', async () => {
      mockConfigManager.getConfig.mockResolvedValue(null);
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await chmodRemoteItem([item], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('No server configured')
      );
      expect(mockConnection.chmod).not.toHaveBeenCalled();
    });

    it('errors when the default server no longer exists', async () => {
      mockConfigManager.getServerById.mockResolvedValue(null);
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await chmodRemoteItem([item], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Server not found')
      );
      expect(mockConnection.chmod).not.toHaveBeenCalled();
    });
  });
});
