import { ServersProvider } from '../../../remoteBrowser/ServersProvider';
import { ServerItem } from '../../../remoteBrowser/ServerItem';

const mockServerManager = {
  getAll: jest.fn(),
  getServer: jest.fn(),
};

const mockCredentialManager = {
  getAll: jest.fn(),
};

const mockBindingManager = {
  getBinding: jest.fn(),
};

const serverA = {
  id: 'server-a',
  name: 'Production',
  type: 'sftp' as const,
  credentialId: 'cred-1',
  rootPath: '/var/www',
};

const serverB = {
  id: 'server-b',
  name: 'Staging',
  type: 'sftp' as const,
  credentialId: 'cred-2',
  rootPath: '/var/www/staging',
};

const credA = {
  id: 'cred-1',
  name: 'Prod Key',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password' as const,
};

const credB = {
  id: 'cred-2',
  name: 'Staging Key',
  host: 'staging.example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'key' as const,
};

describe('ServersProvider', () => {
  let provider: ServersProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServerManager.getAll.mockResolvedValue([serverA, serverB]);
    mockCredentialManager.getAll.mockResolvedValue([credA, credB]);
    mockBindingManager.getBinding.mockResolvedValue({ defaultServerId: 'server-a', servers: {} });

    provider = new ServersProvider(
      mockServerManager as any,
      mockCredentialManager as any,
      mockBindingManager as any
    );
  });

  describe('getChildren', () => {
    it('returns ServerItems for all configured servers', async () => {
      const children = await provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(ServerItem);
      expect(children[1]).toBeInstanceOf(ServerItem);
    });

    it('marks the default server as active', async () => {
      const children = await provider.getChildren();
      const active = children.find(c => c.data.isDefault);
      expect(active).toBeDefined();
      expect(active!.data.server.id).toBe('server-a');
    });

    it('sorts default server first, then alphabetical', async () => {
      // serverB is alphabetically before serverA ("Staging" < "Production"? no, P < S)
      // But default should be first regardless
      mockBindingManager.getBinding.mockResolvedValue({ defaultServerId: 'server-b', servers: {} });
      const children = await provider.getChildren();
      expect(children[0].data.server.id).toBe('server-b');
      expect(children[1].data.server.id).toBe('server-a');
    });

    it('handles missing credentials gracefully', async () => {
      mockCredentialManager.getAll.mockResolvedValue([credA]); // credB missing
      const children = await provider.getChildren();
      expect(children).toHaveLength(2);
      const staging = children.find(c => c.data.server.id === 'server-b');
      expect(staging!.data.credential).toBeUndefined();
    });

    it('returns empty array when no servers configured', async () => {
      mockServerManager.getAll.mockResolvedValue([]);
      const children = await provider.getChildren();
      expect(children).toEqual([]);
    });

    it('handles null binding (no project binding file)', async () => {
      mockBindingManager.getBinding.mockResolvedValue(null);
      const children = await provider.getChildren();
      expect(children).toHaveLength(2);
      // No server should be marked as default
      expect(children.every(c => !c.data.isDefault)).toBe(true);
    });
  });

  describe('getTreeItem', () => {
    it('returns the element directly', async () => {
      const children = await provider.getChildren();
      expect(provider.getTreeItem(children[0])).toBe(children[0]);
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
});
