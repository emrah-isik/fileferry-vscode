import { ServersProvider } from '../../../remoteBrowser/ServersProvider';
import { ServerItem } from '../../../remoteBrowser/ServerItem';
import { ProjectConfig } from '../../../models/ProjectConfig';

const mockConfigManager = {
  getConfig: jest.fn(),
};

const mockCredentialManager = {
  getAll: jest.fn(),
};

const serverA = {
  id: 'server-a',
  type: 'sftp' as const,
  credentialId: 'cred-1',
  credentialName: 'Prod Key',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: '/var/www' }],
  excludedPaths: [],
};

const serverB = {
  id: 'server-b',
  type: 'sftp' as const,
  credentialId: 'cred-2',
  credentialName: 'Staging Key',
  rootPath: '/var/www/staging',
  mappings: [{ localPath: '/', remotePath: '/var/www/staging' }],
  excludedPaths: [],
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

const configFixture: ProjectConfig = {
  defaultServerId: 'server-a',
  servers: {
    Production: serverA,
    Staging: serverB,
  },
};

describe('ServersProvider', () => {
  let provider: ServersProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigManager.getConfig.mockResolvedValue(configFixture);
    mockCredentialManager.getAll.mockResolvedValue([credA, credB]);

    provider = new ServersProvider(
      mockConfigManager as any,
      mockCredentialManager as any
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
      const config: ProjectConfig = { ...configFixture, defaultServerId: 'server-b' };
      mockConfigManager.getConfig.mockResolvedValue(config);
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

    it('returns empty array when no config exists', async () => {
      mockConfigManager.getConfig.mockResolvedValue(null);
      const children = await provider.getChildren();
      expect(children).toEqual([]);
    });

    it('returns empty array when no servers configured', async () => {
      mockConfigManager.getConfig.mockResolvedValue({ defaultServerId: '', servers: {} });
      const children = await provider.getChildren();
      expect(children).toEqual([]);
    });

    it('sets serverName from the config key', async () => {
      const children = await provider.getChildren();
      const prod = children.find(c => c.data.server.id === 'server-a');
      expect(prod!.data.serverName).toBe('Production');
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
