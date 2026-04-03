import { RemoteBrowserProvider } from '../../../remoteBrowser/RemoteBrowserProvider';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

const vscode = require('vscode');

const mockConnection = {
  ensureConnected: jest.fn(),
  listDirectory: jest.fn(),
  downloadFile: jest.fn(),
  disconnect: jest.fn(),
  getRootPath: jest.fn().mockReturnValue('/var/www'),
  onDidDisconnect: jest.fn(),
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
