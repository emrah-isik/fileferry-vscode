import { RemoteBrowserProvider } from '../../../remoteBrowser/RemoteBrowserProvider';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';
import { HostNotTrustedError } from '../../../ssh/connectErrors';

const mockConnection = {
  ensureConnected: jest.fn(),
  listDirectory: jest.fn(),
  resolveSymlinkTargets: jest.fn().mockResolvedValue(new Map()),
  downloadFile: jest.fn(),
  disconnect: jest.fn(),
  getRootPath: jest.fn().mockReturnValue('/var/www'),
  onDidDisconnect: jest.fn(),
  onDidLoseRoute: jest.fn(),
};

describe('RemoteBrowserProvider', () => {
  let provider: RemoteBrowserProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.getRootPath.mockReturnValue('/var/www');
    provider = new RemoteBrowserProvider(mockConnection as any);
  });

  describe('getTreeItem', () => {
    it('returns the element directly', () => {
      const entry: RemoteEntry = {
        name: 'test.log',
        type: '-',
        size: 1024,
        modifyTime: 1710000000000,
        remotePath: '/var/www/test.log',
      };
      const item = new RemoteFileItem(entry);
      expect(provider.getTreeItem(item)).toBe(item);
    });
  });

  describe('render interactivity (18a-1b)', () => {
    // A root render with no preceding gesture is a background connect: it
    // must never prompt. resume() (refresh command, placeholder click, set
    // default server) and navigateTo() mark the NEXT root render as a
    // gesture; the mark is consumed by that one render.
    it('a background root render connects with interactive:false', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);

      await provider.getChildren();

      expect(mockConnection.ensureConnected).toHaveBeenCalledWith({ interactive: false });
    });

    it('resume() makes the next root render interactive — once', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);

      provider.resume();
      await provider.getChildren();
      expect(mockConnection.ensureConnected).toHaveBeenCalledWith({ interactive: true });

      mockConnection.ensureConnected.mockClear();
      await provider.getChildren();
      expect(mockConnection.ensureConnected).toHaveBeenCalledWith({ interactive: false });
    });

    it('navigateTo() counts as a gesture too', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);

      provider.navigateTo('/var/www/html');
      await provider.getChildren();

      expect(mockConnection.ensureConnected).toHaveBeenCalledWith({ interactive: true });
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www/html');
    });

    it('renders the "Host not verified — click to connect" placeholder when the background connect is refused', async () => {
      mockConnection.ensureConnected.mockRejectedValueOnce(new HostNotTrustedError('example.com', 22, 'unknown'));

      const children = await provider.getChildren();

      expect(children).toHaveLength(1);
      const row = children![0];
      expect(row.entry.name).toBe('Host not verified');
      expect(row.description).toBe('Click to connect');
      expect(row.contextValue).toBe('remotePlaceholder');
      expect(row.command?.command).toBe('fileferry.remoteBrowser.refresh');
      expect(row.entry.remotePath).toBe(''); // not a real entry — multi-target commands filter it
    });

    it('keeps the generic error row for other connect failures', async () => {
      mockConnection.ensureConnected.mockRejectedValueOnce(new Error('read ECONNRESET'));

      const children = await provider.getChildren();

      expect(children![0].entry.name).toBe('Connection failed');
    });
  });

  describe('getChildren', () => {
    it('lists rootPath when called with no element', async () => {
      mockConnection.listDirectory.mockResolvedValue([
        { name: 'index.html', type: '-', size: 1024, modifyTime: 1710000000000 },
      ]);

      const children = await provider.getChildren();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www');
      expect(children).toHaveLength(1);
      expect(children![0]).toBeInstanceOf(RemoteFileItem);
      expect(children![0].entry.name).toBe('index.html');
    });

    it('passes the listing mode through to the entry, absent when the server did not report one', async () => {
      mockConnection.listDirectory.mockResolvedValue([
        { name: 'index.html', type: '-', size: 1024, modifyTime: 1710000000000, mode: '644' },
        { name: 'unknown.bin', type: '-', size: 10, modifyTime: 1710000000000 },
      ]);

      const children = await provider.getChildren();
      expect(children![0].entry.mode).toBe('644');
      expect(children![1].entry.mode).toBeUndefined();
    });

    it('lists directory contents when called with a directory item', async () => {
      const dirEntry: RemoteEntry = {
        name: 'logs',
        type: 'd',
        size: 4096,
        modifyTime: 1710000000000,
        remotePath: '/var/www/logs',
      };
      const dirItem = new RemoteFileItem(dirEntry);

      mockConnection.listDirectory.mockResolvedValue([
        { name: 'error.log', type: '-', size: 2048, modifyTime: 1710100000000 },
      ]);

      const children = await provider.getChildren(dirItem);
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www/logs');
      expect(children).toHaveLength(1);
      expect(children![0].entry.name).toBe('error.log');
    });

    it('resolves symlink targets and sets symlinkTarget on entries', async () => {
      mockConnection.listDirectory.mockResolvedValue([
        { name: 'current', type: 'l', size: 11, modifyTime: 1710000000000 },
        { name: 'index.php', type: '-', size: 1024, modifyTime: 1710000000000 },
      ]);
      mockConnection.resolveSymlinkTargets.mockResolvedValue(new Map([['current', 'd']]));

      const children = await provider.getChildren();
      expect(mockConnection.resolveSymlinkTargets).toHaveBeenCalled();
      const symlinkItem = children!.find(c => c.entry.name === 'current')!;
      expect(symlinkItem.entry.symlinkTarget).toBe('d');
    });

    it('expands symlinked directories (lists children)', async () => {
      const symlinkDirEntry: RemoteEntry = {
        name: 'current',
        type: 'l',
        size: 11,
        modifyTime: 1710000000000,
        remotePath: '/var/www/current',
        symlinkTarget: 'd',
      };
      const dirItem = new RemoteFileItem(symlinkDirEntry);

      mockConnection.listDirectory.mockResolvedValue([
        { name: 'app.php', type: '-', size: 2048, modifyTime: 1710100000000 },
      ]);

      const children = await provider.getChildren(dirItem);
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www/current');
      expect(children).toHaveLength(1);
      expect(children![0].entry.name).toBe('app.php');
    });

    it('returns empty array for symlink-to-file items', async () => {
      const symlinkFileEntry: RemoteEntry = {
        name: 'config.ini',
        type: 'l',
        size: 1024,
        modifyTime: 1710000000000,
        remotePath: '/var/www/config.ini',
        symlinkTarget: '-',
      };
      const fileItem = new RemoteFileItem(symlinkFileEntry);

      const children = await provider.getChildren(fileItem);
      expect(children).toEqual([]);
    });

    it('sorts symlinked directories with real directories', async () => {
      mockConnection.listDirectory.mockResolvedValue([
        { name: 'zebra.txt', type: '-', size: 100, modifyTime: 1710000000000 },
        { name: 'current', type: 'l', size: 11, modifyTime: 1710000000000 },
        { name: 'beta', type: 'd', size: 4096, modifyTime: 1710000000000 },
        { name: 'alpha.txt', type: '-', size: 200, modifyTime: 1710000000000 },
      ]);
      mockConnection.resolveSymlinkTargets.mockResolvedValue(new Map([['current', 'd']]));

      const children = await provider.getChildren();
      const names = children!.map(c => c.entry.name);
      // symlinked dir 'current' should sort with directories
      expect(names).toEqual(['beta', 'current', 'alpha.txt', 'zebra.txt']);
    });

    it('returns empty array for file items', async () => {
      const fileEntry: RemoteEntry = {
        name: 'test.log',
        type: '-',
        size: 1024,
        modifyTime: 1710000000000,
        remotePath: '/var/www/test.log',
      };
      const fileItem = new RemoteFileItem(fileEntry);

      const children = await provider.getChildren(fileItem);
      expect(children).toEqual([]);
    });

    it('sorts directories first, then alphabetically', async () => {
      mockConnection.listDirectory.mockResolvedValue([
        { name: 'zebra.txt', type: '-', size: 100, modifyTime: 1710000000000 },
        { name: 'beta', type: 'd', size: 4096, modifyTime: 1710000000000 },
        { name: 'alpha.txt', type: '-', size: 200, modifyTime: 1710000000000 },
        { name: 'alpha', type: 'd', size: 4096, modifyTime: 1710000000000 },
      ]);

      const children = await provider.getChildren();
      const names = children!.map(c => c.entry.name);
      expect(names).toEqual(['alpha', 'beta', 'alpha.txt', 'zebra.txt']);
    });

    it('returns placeholder when no server is configured', async () => {
      mockConnection.listDirectory.mockRejectedValue(new Error('No server configured'));

      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children![0].label).toMatch(/no server configured/i);
    });

    it('returns error placeholder on connection error', async () => {
      mockConnection.listDirectory.mockRejectedValue(new Error('Connection refused'));

      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children![0].label).toMatch(/connection failed/i);
    });

    it('returns permission denied placeholder', async () => {
      mockConnection.listDirectory.mockRejectedValue(new Error('Permission denied'));

      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children![0].label).toMatch(/permission denied/i);
    });

    it('connection error placeholder has reconnect command', async () => {
      mockConnection.listDirectory.mockRejectedValue(new Error('Connection refused'));

      const children = await provider.getChildren();
      expect(children![0].command).toEqual({
        command: 'fileferry.remoteBrowser.refresh',
        title: 'Retry connection',
      });
    });

    it('the error placeholder is NOT a remoteFile — no file context menu on it', async () => {
      mockConnection.listDirectory.mockRejectedValue(new Error('Connection refused'));

      const children = await provider.getChildren();
      // 'remoteFile' would match every file-scoped view/item/context clause
      // (Rename…, Duplicate…, Compare with Local, …) on a row that is not a
      // file. A distinct value matches none of them.
      expect(children![0].contextValue).toBe('remotePlaceholder');
    });

    it('permission denied placeholder has reconnect command', async () => {
      mockConnection.listDirectory.mockRejectedValue(new Error('Permission denied'));

      const children = await provider.getChildren();
      expect(children![0].command).toEqual({
        command: 'fileferry.remoteBrowser.refresh',
        title: 'Retry connection',
      });
    });

    it('no server configured placeholder has open settings command', async () => {
      mockConnection.listDirectory.mockRejectedValue(new Error('No server configured'));

      const children = await provider.getChildren();
      expect(children![0].command).toEqual({
        command: 'fileferry.openSettings',
        title: 'Open settings',
      });
    });
  });

  describe('refresh', () => {
    it('fires onDidChangeTreeData event', () => {
      const listener = jest.fn();
      provider.onDidChangeTreeData(listener);

      provider.refresh();
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('navigateTo', () => {
    it('updates rootPath and fires refresh', async () => {
      const listener = jest.fn();
      provider.onDidChangeTreeData(listener);

      provider.navigateTo('/var/log');

      expect(listener).toHaveBeenCalled();
      // Verify next getChildren uses the new path
      mockConnection.listDirectory.mockResolvedValue([]);
      await provider.getChildren();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/log');
    });
  });

  describe('onDidChangePath', () => {
    it('fires with the browsed path after root getChildren', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);
      const pathListener = jest.fn();
      provider.onDidChangePath(pathListener);

      await provider.getChildren();
      expect(pathListener).toHaveBeenCalledWith('/var/www');
    });

    it('fires with navigated path after navigateTo', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);
      const pathListener = jest.fn();
      provider.onDidChangePath(pathListener);

      provider.navigateTo('/var/log');
      await provider.getChildren();
      expect(pathListener).toHaveBeenCalledWith('/var/log');
    });

    it('does not fire for child directory expansion', async () => {
      const dirEntry: RemoteEntry = {
        name: 'logs',
        type: 'd',
        size: 4096,
        modifyTime: 1710000000000,
        remotePath: '/var/www/logs',
      };
      const dirItem = new RemoteFileItem(dirEntry);
      mockConnection.listDirectory.mockResolvedValue([]);
      const pathListener = jest.fn();
      provider.onDidChangePath(pathListener);

      await provider.getChildren(dirItem);
      expect(pathListener).not.toHaveBeenCalled();
    });

    it('fires empty string on error', async () => {
      mockConnection.listDirectory.mockRejectedValue(new Error('Connection refused'));
      const pathListener = jest.fn();
      provider.onDidChangePath(pathListener);

      await provider.getChildren();
      expect(pathListener).toHaveBeenCalledWith('');
    });
  });

  describe('getCurrentPath (feature 32b — view-title create commands)', () => {
    it('returns null before anything has been listed', () => {
      expect(provider.getCurrentPath()).toBeNull();
    });

    it('returns the browsed path after a root listing', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);

      await provider.getChildren();
      expect(provider.getCurrentPath()).toBe('/var/www');
    });

    it('returns the navigated path after navigateTo + listing', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);

      provider.navigateTo('/var/log');
      await provider.getChildren();
      expect(provider.getCurrentPath()).toBe('/var/log');
    });

    it('is not changed by child directory expansion', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);
      await provider.getChildren();

      const dirEntry: RemoteEntry = {
        name: 'logs',
        type: 'd',
        size: 4096,
        modifyTime: 1710000000000,
        remotePath: '/var/www/logs',
      };
      await provider.getChildren(new RemoteFileItem(dirEntry));
      expect(provider.getCurrentPath()).toBe('/var/www');
    });

    it('returns null again after a failed root listing', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);
      await provider.getChildren();

      mockConnection.listDirectory.mockRejectedValue(new Error('Connection refused'));
      await provider.getChildren();
      expect(provider.getCurrentPath()).toBeNull();
    });
  });

  describe('route eviction (18a-2b, Q34)', () => {
    it('a lost route drops the panel to the Disconnected/click-to-reconnect state', async () => {
      const registration = (mockConnection.onDidLoseRoute as jest.Mock).mock.calls[0];
      expect(registration).toBeDefined();
      const listener = registration[0] as (key: string) => void;

      listener('jump@bastion.example.com:2222');
      await Promise.resolve(); // let the async suspend settle

      expect(mockConnection.disconnect).toHaveBeenCalled();
      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children![0].label).toBe('Disconnected');
    });
  });

  describe('disconnect suspension (feature 33a)', () => {
    it('suspend disconnects the connection and fires a tree refresh', async () => {
      const listener = jest.fn();
      provider.onDidChangeTreeData(listener);

      await provider.suspend();

      expect(mockConnection.disconnect).toHaveBeenCalled();
      expect(listener).toHaveBeenCalled();
    });

    it('while suspended, a root listing shows the Disconnected placeholder and never touches the connection', async () => {
      await provider.suspend();

      const children = await provider.getChildren();

      expect(children).toHaveLength(1);
      expect(children![0].label).toBe('Disconnected');
      expect(children![0].entry.remotePath).toBe('');
      expect(mockConnection.ensureConnected).not.toHaveBeenCalled();
      expect(mockConnection.listDirectory).not.toHaveBeenCalled();
    });

    it('the Disconnected placeholder is wired to the refresh command', async () => {
      await provider.suspend();

      const children = await provider.getChildren();

      expect(children![0].command).toEqual({
        command: 'fileferry.remoteBrowser.refresh',
        title: 'Reconnect',
      });
    });

    it('the Disconnected placeholder is NOT a remoteFile — no file context menu on it', async () => {
      await provider.suspend();

      const children = await provider.getChildren();

      expect(children![0].contextValue).toBe('remotePlaceholder');
    });

    it('suspend clears the current path and announces it', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);
      await provider.getChildren();
      expect(provider.getCurrentPath()).toBe('/var/www');

      const pathListener = jest.fn();
      provider.onDidChangePath(pathListener);
      await provider.suspend();
      await provider.getChildren();

      expect(provider.getCurrentPath()).toBeNull();
      expect(pathListener).toHaveBeenCalledWith('');
    });

    it('internal refresh while suspended stays disconnected', async () => {
      await provider.suspend();

      provider.refresh();
      const children = await provider.getChildren();

      expect(children![0].label).toBe('Disconnected');
      expect(mockConnection.ensureConnected).not.toHaveBeenCalled();
    });

    it('resume reconnects on the next listing', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);
      await provider.suspend();

      provider.resume();
      await provider.getChildren();

      expect(mockConnection.ensureConnected).toHaveBeenCalled();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www');
    });

    it('navigateTo clears suspension and lists the navigated path', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);
      await provider.suspend();

      provider.navigateTo('/var/log');
      await provider.getChildren();

      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/log');
    });

    it('a connection-side disconnect (idle timeout) does not suspend the provider', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);

      // The idle timer lives in the connection and never touches the
      // provider — a later listing must transparently reconnect.
      await mockConnection.disconnect();

      await provider.getChildren();

      expect(mockConnection.ensureConnected).toHaveBeenCalled();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www');
    });
  });

  describe('dynamic root path', () => {
    it('resolves root path after connecting on initial load', async () => {
      // Simulate: getRootPath returns '/' before ensureConnected, '/var/www' after
      mockConnection.getRootPath.mockReturnValue('/');
      mockConnection.ensureConnected.mockImplementation(async () => {
        mockConnection.getRootPath.mockReturnValue('/var/www');
      });
      mockConnection.listDirectory.mockResolvedValue([]);

      const freshProvider = new RemoteBrowserProvider(mockConnection as any);
      await freshProvider.getChildren();
      // Should use the post-connection root path, not '/'
      expect(mockConnection.ensureConnected).toHaveBeenCalled();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www');
    });

    it('picks up updated rootPath from connection on refresh', async () => {
      mockConnection.ensureConnected.mockReset();
      mockConnection.getRootPath.mockReturnValue('/var/www');
      mockConnection.listDirectory.mockResolvedValue([]);

      // Initially uses /var/www
      await provider.getChildren();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www');

      // Server changes, connection now returns different root
      mockConnection.getRootPath.mockReturnValue('/home/deploy/myapp');
      provider.refresh();

      await provider.getChildren();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/home/deploy/myapp');
    });

    it('does not override user navigateTo path on refresh', async () => {
      mockConnection.listDirectory.mockResolvedValue([]);

      // User explicitly navigates
      provider.navigateTo('/var/log');
      await provider.getChildren();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/log');

      // Refresh should keep user's path, not reset to connection root
      mockConnection.getRootPath.mockReturnValue('/var/www');
      provider.refresh();
      await provider.getChildren();
      expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/log');
    });
  });
});
