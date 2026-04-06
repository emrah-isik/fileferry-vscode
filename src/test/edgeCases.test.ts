// Edge case tests for Phase 6 — covers boundary conditions discovered during testing

import { ConfigManager } from '../configManager';
import { GitService } from '../gitService';
import { SftpService } from '../sftpService';
import { ServerConfig } from '../types';

// ─── ConfigManager mocks ─────────────────────────────────────────────────────

jest.mock('vscode', () => ({
  ...jest.requireActual('../test/__mocks__/vscode'),
  workspace: {
    fs: {
      readFile: jest.fn(),
      writeFile: jest.fn(),
    },
    workspaceFolders: [{ uri: { fsPath: '/home/user/project' } }]
  },
  Uri: { file: jest.fn((p: string) => ({ fsPath: p, toString: () => p })) },
  extensions: {
    getExtension: jest.fn().mockReturnValue({
      exports: { getAPI: jest.fn().mockReturnValue({ repositories: [] }) },
      isActive: true
    })
  }
}));

import * as vscode from 'vscode';
const mockReadFile  = vscode.workspace.fs.readFile as jest.Mock;
const mockWriteFile = vscode.workspace.fs.writeFile as jest.Mock;

// ─── SftpService mock ────────────────────────────────────────────────────────

const mockMethods = {
  connect: jest.fn(),
  put: jest.fn(),
  mkdir: jest.fn(),
  end: jest.fn(),
  get: jest.fn(),
  rename: jest.fn(),
  posixRename: jest.fn(),
};

jest.mock('ssh2-sftp-client', () => jest.fn().mockImplementation(() => mockMethods));

// ─── ConfigManager edge cases ────────────────────────────────────────────────

describe('ConfigManager edge cases', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    manager = new ConfigManager();
  });

  it('handles config file with unknown/extra fields gracefully', async () => {
    const raw = {
      servers: [{
        id: 'prod', name: 'Prod', type: 'sftp', host: 'x.com', port: 22,
        username: 'u', authMethod: 'password', mappings: [], excludedPaths: [],
        unknownField: 'should be ignored' // extra field not in our types
      }]
    };
    mockReadFile.mockResolvedValue(new TextEncoder().encode(JSON.stringify(raw)));
    const config = await manager.loadConfig();
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].host).toBe('x.com');
  });

  it('handles empty mappings array — resolveRemotePath returns null', () => {
    const server: ServerConfig = {
      id: 'prod', name: 'Prod', type: 'sftp', host: 'x.com',
      port: 22, username: 'u', authMethod: 'password',
      mappings: [], excludedPaths: []
    };
    const result = manager.resolveRemotePath(server, '/proj/src/app.php', '/proj');
    expect(result).toBeNull();
  });

  it('handles Windows-style backslash paths in local path', () => {
    const server: ServerConfig = {
      id: 'prod', name: 'Prod', type: 'sftp', host: 'x.com',
      port: 22, username: 'u', authMethod: 'password',
      mappings: [{ localPath: '/', remotePath: '/var/www' }],
      excludedPaths: []
    };
    // Windows paths use backslashes — we normalise internally
    const result = manager.resolveRemotePath(
      server,
      'C:\\Users\\user\\project\\src\\app.php',
      'C:\\Users\\user\\project'
    );
    expect(result).toBe('/var/www/src/app.php');
  });

  it('handles deeply nested excluded path pattern', () => {
    const server: ServerConfig = {
      id: 'prod', name: 'Prod', type: 'sftp', host: 'x.com',
      port: 22, username: 'u', authMethod: 'password',
      mappings: [{ localPath: '/', remotePath: '/var/www' }],
      excludedPaths: ['.env']
    };
    expect(manager.resolveRemotePath(server, '/proj/.env', '/proj')).toBeNull();
    expect(manager.resolveRemotePath(server, '/proj/src/app.php', '/proj')).not.toBeNull();
  });

  it('resolveRemotePath strips trailing slash from remotePath correctly', () => {
    const server: ServerConfig = {
      id: 'prod', name: 'Prod', type: 'sftp', host: 'x.com',
      port: 22, username: 'u', authMethod: 'password',
      mappings: [{ localPath: '/', remotePath: '/var/www/' }], // trailing slash
      excludedPaths: []
    };
    const result = manager.resolveRemotePath(server, '/proj/index.php', '/proj');
    // Should not produce double slash like /var/www//index.php
    expect(result).toBe('/var/www/index.php');
    expect(result).not.toContain('//');
  });
});

// ─── GitService edge cases ────────────────────────────────────────────────────

describe('GitService edge cases', () => {
  it('returns "unknown" for detached HEAD state (HEAD has no name)', () => {
    const mockGetAPI = (vscode.extensions.getExtension('vscode.git') as any).exports.getAPI as jest.Mock;
    mockGetAPI.mockReturnValue({
      repositories: [{
        rootUri: { fsPath: '/proj' },
        state: {
          HEAD: { name: undefined, commit: 'abc123' }, // detached HEAD
          workingTreeChanges: [], indexChanges: [], untrackedChanges: []
        }
      }]
    });
    const service = new GitService();
    expect(service.getBranchName('/proj')).toBe('unknown');
  });

  it('returns empty files for repository with no changes', () => {
    const mockGetAPI = (vscode.extensions.getExtension('vscode.git') as any).exports.getAPI as jest.Mock;
    mockGetAPI.mockReturnValue({
      repositories: [{
        rootUri: { fsPath: '/proj' },
        state: {
          HEAD: { name: 'main', commit: 'abc' },
          workingTreeChanges: [], indexChanges: [], untrackedChanges: []
        }
      }]
    });
    const service = new GitService();
    expect(service.getChangedFiles('/proj')).toHaveLength(0);
  });

  it('handles repository root path with spaces', () => {
    const mockGetAPI = (vscode.extensions.getExtension('vscode.git') as any).exports.getAPI as jest.Mock;
    mockGetAPI.mockReturnValue({
      repositories: [{
        rootUri: { fsPath: '/home/user/my project' },
        state: {
          HEAD: { name: 'main', commit: 'abc' },
          workingTreeChanges: [
            { uri: { fsPath: '/home/user/my project/src/app.php' }, status: 5 }
          ],
          indexChanges: [], untrackedChanges: []
        }
      }]
    });
    const service = new GitService();
    const files = service.getChangedFiles('/home/user/my project');
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('src/app.php');
  });

  it('deduplicates files that appear in both workingTree and index changes', () => {
    const mockGetAPI = (vscode.extensions.getExtension('vscode.git') as any).exports.getAPI as jest.Mock;
    mockGetAPI.mockReturnValue({
      repositories: [{
        rootUri: { fsPath: '/proj' },
        state: {
          HEAD: { name: 'main', commit: 'abc' },
          workingTreeChanges: [
            { uri: { fsPath: '/proj/src/app.php' }, status: 5 }
          ],
          indexChanges: [
            { uri: { fsPath: '/proj/src/app.php' }, status: 2 } // same file, staged
          ],
          untrackedChanges: []
        }
      }]
    });
    const service = new GitService();
    const files = service.getChangedFiles('/proj');
    // Should not appear twice
    expect(files).toHaveLength(1);
  });
});

// ─── SftpService edge cases ───────────────────────────────────────────────────

describe('SftpService edge cases', () => {
  let service: SftpService;
  const server: ServerConfig = {
    id: 'prod', name: 'Prod', type: 'sftp', host: 'x.com',
    port: 22, username: 'u', authMethod: 'password', mappings: [], excludedPaths: []
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMethods.connect.mockResolvedValue(undefined);
    mockMethods.put.mockResolvedValue(undefined);
    mockMethods.end.mockResolvedValue(undefined);
    service = new SftpService();
    await service.connect(server, { password: 'secret' });
  });

  it('uploads a 0-byte file without error', async () => {
    await service.uploadFile('/local/empty.txt', '/remote/empty.txt');
    expect(mockMethods.put).toHaveBeenCalledWith('/local/empty.txt', '/remote/empty.txt.fileferry.tmp');
    expect(mockMethods.posixRename).toHaveBeenCalledWith('/remote/empty.txt.fileferry.tmp', '/remote/empty.txt');
  });

  it('handles remote path with spaces', async () => {
    await service.uploadFile('/local/app.php', '/var/www/my site/app.php');
    expect(mockMethods.put).toHaveBeenCalledWith('/local/app.php', '/var/www/my site/app.php.fileferry.tmp');
    expect(mockMethods.posixRename).toHaveBeenCalledWith('/var/www/my site/app.php.fileferry.tmp', '/var/www/my site/app.php');
  });

  it('disconnect is safe to call when already disconnected', async () => {
    await service.disconnect();
    // Second disconnect should not throw
    await expect(service.disconnect()).resolves.not.toThrow();
  });

  it('uploadFiles returns all failed when every upload throws', async () => {
    mockMethods.put.mockRejectedValue(new Error('Permission denied'));
    const results = await service.uploadFiles([
      { localPath: '/a.php', remotePath: '/r/a.php' },
      { localPath: '/b.php', remotePath: '/r/b.php' },
    ], jest.fn());
    expect(results.failed).toHaveLength(2);
    expect(results.succeeded).toHaveLength(0);
  });
});
