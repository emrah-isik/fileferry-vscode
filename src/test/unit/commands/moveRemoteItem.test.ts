jest.mock('../../../commands/pickRemoteDirectory');

import { pickRemoteDirectory } from '../../../commands/pickRemoteDirectory';
import { moveRemoteItem } from '../../../commands/moveRemoteItem';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';
import { RemoteEditSessionRegistry, RemoteEditSession } from '../../../services/RemoteEditSessionRegistry';

const vscode = require('vscode');

const mockPickRemoteDirectory = pickRemoteDirectory as jest.Mock;

const mockConnection = {
  rename: jest.fn(),
  deleteRemoteFile: jest.fn(),
  statRemoteType: jest.fn(),
  exists: jest.fn(),
  getCurrentServerId: jest.fn(),
  getRootPath: jest.fn(),
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

function makeSession(overrides: Partial<RemoteEditSession> = {}): RemoteEditSession {
  return {
    serverId: 'server-1',
    remotePath: '/var/www/index.php',
    downloadedMtimeMs: 1780000000000,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('moveRemoteItem', () => {
  let registry: RemoteEditSessionRegistry;

  function dependencies() {
    return {
      connection: mockConnection as any,
      configManager: mockConfigManager as any,
      registry,
      output: mockOutput as any,
      refresh: mockRefresh,
      getCurrentPath: () => '/var/www',
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new RemoteEditSessionRegistry();

    mockPickRemoteDirectory.mockResolvedValue('/var/www/archive');
    vscode.window.withProgress.mockImplementation(
      (_options: any, task: (progress: any) => Promise<any>) => task({ report: jest.fn() })
    );
    mockConfigManager.getConfig.mockResolvedValue(baseConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server });
    mockConnection.rename.mockResolvedValue(undefined);
    mockConnection.deleteRemoteFile.mockResolvedValue(undefined);
    mockConnection.statRemoteType.mockResolvedValue(null);
    mockConnection.exists.mockResolvedValue(false);
    mockConnection.getCurrentServerId.mockReturnValue('server-1');
    mockConnection.getRootPath.mockReturnValue('/var/www');
  });

  describe('picker and guards', () => {
    it('does nothing when the target list is empty', async () => {
      await moveRemoteItem([], dependencies());

      expect(mockPickRemoteDirectory).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
    });

    it('starts the picker at the panel current path', async () => {
      mockPickRemoteDirectory.mockResolvedValue(undefined);
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(mockPickRemoteDirectory).toHaveBeenCalledWith(mockConnection, '/var/www', expect.any(String));
    });

    it('falls back to the server root when the panel has no current path', async () => {
      mockPickRemoteDirectory.mockResolvedValue(undefined);
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], { ...dependencies(), getCurrentPath: () => null });

      expect(mockPickRemoteDirectory).toHaveBeenCalledWith(mockConnection, '/var/www', expect.any(String));
    });

    it('does nothing when the picker is dismissed', async () => {
      mockPickRemoteDirectory.mockResolvedValue(undefined);
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('errors before any network call when a folder would move into itself', async () => {
      mockPickRemoteDirectory.mockResolvedValue('/var/www/app');
      const item = makeItem({ name: 'app', type: 'd', size: 4096, remotePath: '/var/www/app' });

      await moveRemoteItem([item], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('app')
      );
      expect(mockConnection.statRemoteType).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('errors when a folder would move into its own descendant', async () => {
      mockPickRemoteDirectory.mockResolvedValue('/var/www/app/sub/deep');
      const item = makeItem({ name: 'app', type: 'd', size: 4096, remotePath: '/var/www/app' });

      await moveRemoteItem([item], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
    });

    it('skips a target already in the chosen folder and says so', async () => {
      mockPickRemoteDirectory.mockResolvedValue('/var/www');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('already')
      );
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('drops a selected child of a selected folder before moving (descendant dedupe)', async () => {
      const directoryItem = makeItem({ name: 'app', type: 'd', size: 4096, remotePath: '/var/www/app' });
      const childItem = makeItem({ name: 'inner.php', remotePath: '/var/www/app/inner.php' });

      await moveRemoteItem([directoryItem, childItem], dependencies());

      expect(mockConnection.rename).toHaveBeenCalledTimes(1);
      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/app', '/var/www/archive/app');
    });
  });

  describe('single target', () => {
    it('moves a file to the picked folder, rewrites its session, and refreshes', async () => {
      registry.register('/tmp/fileferry-browse/index.remote.abc123.php', makeSession());
      const rewriteSpy = jest.spyOn(registry, 'rewriteRemotePath');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/index.php', '/var/www/archive/index.php');
      expect(rewriteSpy).toHaveBeenCalledTimes(1);
      expect(rewriteSpy).toHaveBeenCalledWith('server-1', '/var/www/index.php', '/var/www/archive/index.php');
      expect(registry.get('/tmp/fileferry-browse/index.remote.abc123.php')?.remotePath).toBe('/var/www/archive/index.php');
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(check) Moved'),
        expect.any(Number)
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('moves a folder through the same rename call, sessions inside following via prefix', async () => {
      registry.register(
        '/tmp/fileferry-browse/inner.remote.def456.php',
        makeSession({ remotePath: '/var/www/app/inner.php' })
      );
      const item = makeItem({ name: 'app', type: 'd', size: 4096, remotePath: '/var/www/app' });

      await moveRemoteItem([item], dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/app', '/var/www/archive/app');
      expect(registry.get('/tmp/fileferry-browse/inner.remote.def456.php')?.remotePath).toBe('/var/www/archive/app/inner.php');
    });

    it('does not double the slash when moving to the filesystem root', async () => {
      mockPickRemoteDirectory.mockResolvedValue('/');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/index.php', '/index.php');
    });

    it('collision with a file prompts Overwrite/Cancel — Overwrite deletes then renames', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue('Overwrite');
      const callOrder: string[] = [];
      mockConnection.deleteRemoteFile.mockImplementation(async () => { callOrder.push('delete'); });
      mockConnection.rename.mockImplementation(async () => { callOrder.push('rename'); });
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('index.php'),
        expect.objectContaining({ modal: true }),
        'Overwrite'
      );
      expect(mockConnection.deleteRemoteFile).toHaveBeenCalledWith('/var/www/archive/index.php');
      expect(callOrder).toEqual(['delete', 'rename']);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('collision with a file: Cancel moves nothing', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue(undefined);
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('collision with a folder aborts with an error, never merges', async () => {
      mockConnection.statRemoteType.mockResolvedValue('d');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
    });

    it('refreshes when the rename fails AFTER the overwrite delete removed the target', async () => {
      mockConnection.statRemoteType.mockResolvedValue('-');
      vscode.window.showWarningMessage.mockResolvedValue('Overwrite');
      mockConnection.rename.mockRejectedValue(new Error('Connection lost'));
      const rewriteSpy = jest.spyOn(registry, 'rewriteRemotePath');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection lost')
      );
      expect(rewriteSpy).not.toHaveBeenCalled();
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('does not rewrite the session when a clean rename fails', async () => {
      mockConnection.rename.mockRejectedValue(new Error('Permission denied'));
      const rewriteSpy = jest.spyOn(registry, 'rewriteRemotePath');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
      expect(rewriteSpy).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('honours dry run after picking: logs the plan, touches nothing', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });
      const rewriteSpy = jest.spyOn(registry, 'rewriteRemotePath');
      const item = makeItem({ name: 'index.php', remotePath: '/var/www/index.php' });

      await moveRemoteItem([item], dependencies());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        '[remote-move] DRY RUN — would move /var/www/index.php → /var/www/archive/index.php (Production)'
      );
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('$(beaker)'),
        expect.any(Number)
      );
      expect(mockConnection.statRemoteType).not.toHaveBeenCalled();
      expect(mockConnection.exists).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(rewriteSpy).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('multiple targets', () => {
    const itemA = () => makeItem({ name: 'a.txt', remotePath: '/var/www/a.txt' });
    const itemB = () => makeItem({ name: 'b.txt', remotePath: '/var/www/b.txt' });

    it('moves sequentially under one notification, rewrites per entry, refreshes once', async () => {
      const rewriteSpy = jest.spyOn(registry, 'rewriteRemotePath');

      await moveRemoteItem([itemA(), itemB()], dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/a.txt', '/var/www/archive/a.txt');
      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/b.txt', '/var/www/archive/b.txt');
      const progressOptions = vscode.window.withProgress.mock.calls[0][0];
      expect(progressOptions.location).toBe(vscode.ProgressLocation.Notification);
      expect(progressOptions.title).toContain('2');
      expect(rewriteSpy).toHaveBeenCalledWith('server-1', '/var/www/a.txt', '/var/www/archive/a.txt');
      expect(rewriteSpy).toHaveBeenCalledWith('server-1', '/var/www/b.txt', '/var/www/archive/b.txt');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Moved 2 items')
      );
    });

    it('never prompts: a colliding item is skipped and named, nothing overwritten', async () => {
      mockConnection.exists.mockImplementation(async (remotePath: string) =>
        remotePath === '/var/www/archive/a.txt'
      );

      await moveRemoteItem([itemA(), itemB()], dependencies());

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockConnection.deleteRemoteFile).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalledWith('/var/www/a.txt', expect.any(String));
      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/b.txt', '/var/www/archive/b.txt');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('a.txt')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('continues past a failure, aggregates it, and still refreshes once', async () => {
      mockConnection.rename
        .mockRejectedValueOnce(new Error('Permission denied'))
        .mockResolvedValue(undefined);

      await moveRemoteItem([itemA(), itemB()], dependencies());

      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/b.txt', '/var/www/archive/b.txt');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('a.txt')
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('skips already-in-place targets with a note and moves the rest', async () => {
      const inPlaceItem = makeItem({ name: 'kept.txt', remotePath: '/var/www/archive/kept.txt' });

      await moveRemoteItem([itemA(), inPlaceItem], dependencies());

      expect(mockConnection.rename).toHaveBeenCalledTimes(1);
      expect(mockConnection.rename).toHaveBeenCalledWith('/var/www/a.txt', '/var/www/archive/a.txt');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('kept.txt')
      );
    });

    it('honours dry run per target', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ ...baseConfig, dryRun: true });

      await moveRemoteItem([itemA(), itemB()], dependencies());

      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('DRY RUN — would move /var/www/a.txt')
      );
      expect(mockOutput.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('DRY RUN — would move /var/www/b.txt')
      );
      expect(mockConnection.exists).not.toHaveBeenCalled();
      expect(mockConnection.rename).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });
});
