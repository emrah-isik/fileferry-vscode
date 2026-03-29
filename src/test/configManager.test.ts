import { ConfigManager } from '../configManager';
import { FileFerryConfig, ServerConfig } from '../types';

// jest.mock() is hoisted before ALL variable declarations by Jest's Babel transform.
// The only values accessible inside the factory are jest.fn() calls — nothing else.
// We retrieve the mocks after the fact via jest.mocked() / require().
jest.mock('vscode', () => ({
  ...jest.requireActual('../test/__mocks__/vscode'),
  workspace: {
    fs: {
      readFile: jest.fn(),
      writeFile: jest.fn(),
    },
    workspaceFolders: [
      { uri: { fsPath: '/home/user/myproject' } }
    ]
  },
  Uri: {
    file: jest.fn((path: string) => ({ fsPath: path, toString: () => path }))
  }
}));

// Grab the mocked functions AFTER jest.mock has run
import * as vscode from 'vscode';
const mockReadFile = vscode.workspace.fs.readFile as jest.Mock;
const mockWriteFile = vscode.workspace.fs.writeFile as jest.Mock;

describe('ConfigManager', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    manager = new ConfigManager();
  });

  describe('loadConfig', () => {
    it('returns empty config when file does not exist', async () => {
      mockReadFile.mockRejectedValue({ code: 'FileNotFound' });
      const config = await manager.loadConfig();
      expect(config.servers).toEqual([]);
    });

    it('parses valid JSON config', async () => {
      const raw: FileFerryConfig = {
        servers: [{
          id: 'prod',
          name: 'Production',
          type: 'sftp',
          host: 'example.com',
          port: 22,
          username: 'deploy',
          authMethod: 'password',
          mappings: [{ localPath: '/', remotePath: '/var/www' }],
          excludedPaths: []
        }]
      };
      mockReadFile.mockResolvedValue(new TextEncoder().encode(JSON.stringify(raw)));
      const config = await manager.loadConfig();
      expect(config.servers).toHaveLength(1);
      expect(config.servers[0].host).toBe('example.com');
    });

    it('throws on invalid JSON', async () => {
      mockReadFile.mockResolvedValue(new TextEncoder().encode('{ invalid'));
      await expect(manager.loadConfig()).rejects.toThrow('Invalid JSON');
    });
  });

  describe('saveConfig', () => {
    it('writes serialized config to disk', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      const config: FileFerryConfig = { servers: [] };
      await manager.saveConfig(config);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const writtenBytes = mockWriteFile.mock.calls[0][1];
      const decoded = new TextDecoder().decode(writtenBytes);
      expect(JSON.parse(decoded)).toEqual(config);
    });
  });

  describe('addServer', () => {
    it('generates a unique id for the new server', async () => {
      mockReadFile.mockRejectedValue({ code: 'FileNotFound' });
      mockWriteFile.mockResolvedValue(undefined);
      const partial = {
        name: 'Staging',
        type: 'sftp' as const,
        host: 'staging.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password' as const,
        mappings: [],
        excludedPaths: []
      };
      const saved = await manager.addServer(partial);
      expect(saved.id).toBeDefined();
      expect(saved.id.length).toBeGreaterThan(0);
    });

    it('adds server to existing config', async () => {
      const existing: FileFerryConfig = {
        servers: [{
          id: 'prod', name: 'Prod', type: 'sftp',
          host: 'prod.com', port: 22, username: 'u',
          authMethod: 'password', mappings: [], excludedPaths: []
        }]
      };
      mockReadFile.mockResolvedValue(new TextEncoder().encode(JSON.stringify(existing)));
      mockWriteFile.mockResolvedValue(undefined);
      await manager.addServer({
        name: 'Staging', type: 'sftp', host: 'staging.com',
        port: 22, username: 'u', authMethod: 'password', mappings: [], excludedPaths: []
      });
      const written = JSON.parse(new TextDecoder().decode(mockWriteFile.mock.calls[0][1]));
      expect(written.servers).toHaveLength(2);
    });
  });

  describe('removeServer', () => {
    it('removes server by id and saves', async () => {
      const existing: FileFerryConfig = {
        servers: [
          { id: 'prod', name: 'Prod', type: 'sftp', host: 'p.com', port: 22, username: 'u', authMethod: 'password', mappings: [], excludedPaths: [] },
          { id: 'staging', name: 'Staging', type: 'sftp', host: 's.com', port: 22, username: 'u', authMethod: 'password', mappings: [], excludedPaths: [] },
        ]
      };
      mockReadFile.mockResolvedValue(new TextEncoder().encode(JSON.stringify(existing)));
      mockWriteFile.mockResolvedValue(undefined);
      await manager.removeServer('prod');
      const written = JSON.parse(new TextDecoder().decode(mockWriteFile.mock.calls[0][1]));
      expect(written.servers).toHaveLength(1);
      expect(written.servers[0].id).toBe('staging');
    });
  });

  describe('resolveRemotePath', () => {
    const server: ServerConfig = {
      id: 'prod', name: 'Prod', type: 'sftp',
      host: 'x.com', port: 22, username: 'u',
      authMethod: 'password',
      mappings: [
        { localPath: '/', remotePath: '/var/www' },
        { localPath: '/public', remotePath: '/var/www/public_html' }
      ],
      excludedPaths: []
    };

    it('maps local path to remote using root mapping', () => {
      const result = manager.resolveRemotePath(
        server,
        '/home/user/project/src/index.php',
        '/home/user/project'
      );
      expect(result).toBe('/var/www/src/index.php');
    });

    it('uses longest prefix match (most specific mapping wins)', () => {
      const result = manager.resolveRemotePath(
        server,
        '/home/user/project/public/index.php',
        '/home/user/project'
      );
      expect(result).toBe('/var/www/public_html/index.php');
    });

    it('returns null for excluded path patterns', () => {
      const serverWithExcludes: ServerConfig = {
        ...server,
        excludedPaths: ['node_modules', '*.log']
      };
      const result = manager.resolveRemotePath(
        serverWithExcludes,
        '/home/user/project/node_modules/lodash/index.js',
        '/home/user/project'
      );
      expect(result).toBeNull();
    });

    it('returns null for excluded glob patterns', () => {
      const serverWithExcludes: ServerConfig = {
        ...server,
        excludedPaths: ['*.log']
      };
      const result = manager.resolveRemotePath(
        serverWithExcludes,
        '/home/user/project/debug.log',
        '/home/user/project'
      );
      expect(result).toBeNull();
    });

    it('returns null when no mapping matches', () => {
      const serverNoMappings: ServerConfig = { ...server, mappings: [] };
      const result = manager.resolveRemotePath(
        serverNoMappings,
        '/home/user/project/src/index.php',
        '/home/user/project'
      );
      expect(result).toBeNull();
    });
  });
});
