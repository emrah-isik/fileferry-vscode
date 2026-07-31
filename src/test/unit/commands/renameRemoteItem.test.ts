import { renameRemoteItem } from '../../../commands/renameRemoteItem';
import { RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';
import { RemoteEditSessionRegistry, RemoteEditSession } from '../../../services/RemoteEditSessionRegistry';

const vscode = require('vscode');

const mockConnection = {
  statRemoteType: jest.fn(),
  rename: jest.fn(),
  deleteRemoteFile: jest.fn(),
  getCurrentServerId: jest.fn(),
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

function makeEntry(overrides: Partial<RemoteEntry> & { name: string; remotePath: string }): RemoteEntry {
  return {
    type: '-',
    size: 1024,
    modifyTime: 1710000000000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<RemoteEditSession> = {}): RemoteEditSession {
  return {
    serverId: 'server-1',
    remotePath: '/var/www/index.php',
    downloadedMtimeMs: 1780000000000,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('renameRemoteItem', () => {
  let registry: RemoteEditSessionRegistry;

  function dependencies() {
    return {
      connection: mockConnection as any,
      configManager: mockConfigManager as any,
      registry,
      output: mockOutput as any,
      refresh: mockRefresh,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new RemoteEditSessionRegistry();

    vscode.window.showInputBox.mockResolvedValue('renamed.php');
    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server });
    mockConnection.statRemoteType.mockResolvedValue(null);
    mockConnection.rename.mockResolvedValue(undefined);
    mockConnection.deleteRemoteFile.mockResolvedValue(undefined);
    mockConnection.getCurrentServerId.mockReturnValue('server-1');
  });

  describe('guards and input', () => {
    it('ignores the disconnected/error placeholder row (empty remotePath)', async () => {
      const entry = makeEntry({ name: 'Disconnected', remotePath: '' });

      await renameRemoteItem(entry, dependencies());

      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
    });

    it('does nothing when the input box is cancelled', async () => {
      vscode.window.showInputBox.mockResolvedValue(undefined);
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.statRemoteType).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('prefills the current name and selects the stem, leaving the extension out', async () => {
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
      expect(inputBoxOptions.value).toBe('index.php');
      expect(inputBoxOptions.valueSelection).toEqual([0, 5]);
    });

    it('selects the whole name for a directory', async () => {
      const entry = makeEntry({ name: 'assets.old', type: 'd', size: 4096, remotePath: '/var/www/assets.old' });

      await renameRemoteItem(entry, dependencies());

      const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
      expect(inputBoxOptions.value).toBe('assets.old');
      expect(inputBoxOptions.valueSelection).toEqual([0, 10]);
    });

    it('wires the shared name validator into the input box', async () => {
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      const inputBoxOptions = vscode.window.showInputBox.mock.calls[0][0];
      expect(inputBoxOptions.validateInput('a/b')).toBeTruthy();
      expect(inputBoxOptions.validateInput('a\\b')).toBeTruthy();
      expect(inputBoxOptions.validateInput('..')).toBeTruthy();
      expect(inputBoxOptions.validateInput('   ')).toBeTruthy();
      expect(inputBoxOptions.validateInput('renamed.php')).toBeFalsy();
    });

    it('is a silent no-op when the name is unchanged', async () => {
      vscode.window.showInputBox.mockResolvedValue('index.php');
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.statRemoteType).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('treats a name that only differs by surrounding whitespace as unchanged', async () => {
      vscode.window.showInputBox.mockResolvedValue('  index.php  ');
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.rename).not.toHaveBeenCalled();
    });
  });

  describe('path building', () => {
    it('joins the new name to the same parent with POSIX slashes', async () => {
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/index.php', '/var/www/renamed.php');
    });

    it('does not double the slash when renaming at the filesystem root', async () => {
      vscode.window.showInputBox.mockResolvedValue('renamed.txt');
      const entry = makeEntry({ name: 'file.txt', remotePath: '/file.txt' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/file.txt', '/renamed.txt');
    });

    it('trims the entered name before building the target path', async () => {
      vscode.window.showInputBox.mockResolvedValue('  renamed.php  ');
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/index.php', '/var/www/renamed.php');
    });
  });

  describe('dry run', () => {
    it('logs the plan and touches nothing on the network', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });
      const rewriteSpy = jest.spyOn(registry, 'rewriteRemotePath');

      await renameRemoteItem(entry, dependencies());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        '[remote-rename] DRY RUN — would rename /var/www/index.php → /var/www/renamed.php (Production)'
      );
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(beaker)'),
        expect.any(Number)
      );
      expect(mockConnection.statRemoteType).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
      expect(rewriteSpy).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('renames, confirms in the status bar, and refreshes the panel', async () => {
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/index.php', '/var/www/renamed.php');
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(check) Renamed'),
        expect.any(Number)
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('renames a directory through the same call', async () => {
      vscode.window.showInputBox.mockResolvedValue('site');
      const entry = makeEntry({ name: 'app', type: 'd', size: 4096, remotePath: '/var/www/app' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/app', '/var/www/site');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('edit-session rewrite (C2)', () => {
    it('rebinds an open session on the renamed file to the new path, exactly once', async () => {
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });
      registry.register('/tmp/fileferry-browse/index.remote.abc123.php', makeSession());
      const rewriteSpy = jest.spyOn(registry, 'rewriteRemotePath');

      await renameRemoteItem(entry, dependencies());

      expect(rewriteSpy).toHaveBeenCalledTimes(1);
      expect(rewriteSpy).toHaveBeenCalledWith('server-1', '/var/www/index.php', '/var/www/renamed.php');
      expect(registry.get('/tmp/fileferry-browse/index.remote.abc123.php')?.remotePath).toBe('/var/www/renamed.php');
    });

    it('rebinds sessions on files inside a renamed folder (prefix rewrite)', async () => {
      vscode.window.showInputBox.mockResolvedValue('site');
      const entry = makeEntry({ name: 'app', type: 'd', size: 4096, remotePath: '/var/www/app' });
      registry.register(
        '/tmp/fileferry-browse/one.remote.abc123.php',
        makeSession({ remotePath: '/var/www/app/sub/one.php' })
      );

      await renameRemoteItem(entry, dependencies());

      expect(registry.get('/tmp/fileferry-browse/one.remote.abc123.php')?.remotePath).toBe('/var/www/site/sub/one.php');
    });

    it('does not rewrite when the rename fails', async () => {
      mockConnection.rename.mockRejectedValue(new Error('Permission denied'));
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });
      const rewriteSpy = jest.spyOn(registry, 'rewriteRemotePath');

      await renameRemoteItem(entry, dependencies());

      expect(rewriteSpy).not.toHaveBeenCalled();
    });
  });

  describe('collision handling (L3)', () => {
    it('file target: renames after the user confirms Overwrite, deleting the target first', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue('Overwrite');
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('renamed.php'),
        expect.objectContaining({ modal: true }),
        'Overwrite'
      );
      expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/renamed.php');
      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/index.php', '/var/www/renamed.php');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('file target: does nothing when the user cancels the overwrite', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue(undefined);
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('folder target: aborts with an error, never merges', async () => {
      mockConnection.statRemoteType.mockResolvedValue('d');
      const entry = makeEntry({ name: 'app', type: 'd', size: 4096, remotePath: '/var/www/app' });
      vscode.window.showInputBox.mockResolvedValue('site');

      await renameRemoteItem(entry, dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('site')
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('symlink target counts as a file and gets the overwrite prompt', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue('Overwrite');
      const entry = makeEntry({ name: 'current', type: 'l', size: 11, remotePath: '/var/www/current' });
      vscode.window.showInputBox.mockResolvedValue('previous');

      await renameRemoteItem(entry, dependencies());

      expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/previous');
      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/current', '/var/www/previous');
    });
  });

  describe('failures', () => {
    it('shows the error and does not refresh when the rename fails cleanly', async () => {
      mockConnection.rename.mockRejectedValue(new Error('Permission denied'));
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('refreshes when the rename fails AFTER the overwrite delete removed the target', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue('Overwrite');
      mockConnection.rename.mockRejectedValue(new Error('Connection lost'));
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection lost')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('shows the error when the collision pre-check itself fails', async () => {
      mockConnection.statRemoteType.mockRejectedValue(new Error('Connection refused'));
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection refused')
      );
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('configuration errors', () => {
    it('errors when no server is configured', async () => {
      mockConfigManager.getConfig.mockResolvedValue(null);
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('No server configured')
      );
      expect(mockConnection.rename).not.toHaveBeenCalled();
    });

    it('errors when the default server no longer exists', async () => {
      mockConfigManager.getServerById.mockResolvedValue(null);
      const entry = makeEntry({ name: 'index.php', remotePath: '/var/www/index.php' });

      await renameRemoteItem(entry, dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Server not found')
      );
      expect(mockConnection.rename).not.toHaveBeenCalled();
    });
  });
});
