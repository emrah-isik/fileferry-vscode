import { SftpService } from '../sftpService';
import { ServerConfig } from '../types';
import * as fs from 'fs';
import * as agentResolverModule from '../ssh/agentResolver';

// Mock for the underlying ssh2 Client that ssh2-sftp-client wraps
const mockSsh2Client = {
  on: jest.fn(),
  removeAllListeners: jest.fn(),
};

// Shared mock methods — defined outside the factory so tests can configure them.
// jest.mock is hoisted but jest.fn() calls inside the factory capture these refs.
const mockMethods = {
  connect: jest.fn(),
  put: jest.fn(),
  mkdir: jest.fn(),
  end: jest.fn(),
  get: jest.fn(),
  list: jest.fn(),
  realPath: jest.fn(),
  delete: jest.fn(),
  rmdir: jest.fn(),
  rename: jest.fn(),
  posixRename: jest.fn(),
  stat: jest.fn(),
  chmod: jest.fn(),
  client: mockSsh2Client,
};

jest.mock('ssh2-sftp-client', () => {
  return jest.fn().mockImplementation(() => mockMethods);
});

jest.mock('fs');
jest.mock('../ssh/agentResolver');

const serverConfig: ServerConfig = {
  id: 'prod',
  name: 'Production',
  type: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/var/www' }],
  excludedPaths: []
};

describe('SftpService', () => {
  let service: SftpService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SftpService();
  });

  describe('connect', () => {
    it('connects with password auth', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
      expect(mockMethods.connect).toHaveBeenCalledWith(expect.objectContaining({
        host: 'example.com',
        port: 22,
        username: 'deploy',
        password: 'secret'
      }));
    });

    it('connects with agent auth using resolved socket', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      (agentResolverModule.resolveAgentSocket as jest.Mock).mockReturnValue('/tmp/ssh-agent.sock');
      const agentConfig: ServerConfig = { ...serverConfig, authMethod: 'agent' };
      await service.connect(agentConfig, {});
      expect(agentResolverModule.resolveAgentSocket).toHaveBeenCalledWith(undefined);
      expect(mockMethods.connect).toHaveBeenCalledWith(expect.objectContaining({
        agent: '/tmp/ssh-agent.sock'
      }));
    });

    it('passes custom agentSocketPath to resolver', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      (agentResolverModule.resolveAgentSocket as jest.Mock).mockReturnValue('/custom/agent.sock');
      const agentConfig: ServerConfig = {
        ...serverConfig, authMethod: 'agent', agentSocketPath: '/custom/agent.sock'
      };
      await service.connect(agentConfig, {});
      expect(agentResolverModule.resolveAgentSocket).toHaveBeenCalledWith('/custom/agent.sock');
    });

    it('throws on connection failure', async () => {
      mockMethods.connect.mockRejectedValue(new Error('Connection refused'));
      await expect(service.connect(serverConfig, { password: 'x' }))
        .rejects.toThrow('Connection refused');
    });

    it('passes default algorithms including rsa-sha2-256 and rsa-sha2-512', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
      const config = mockMethods.connect.mock.calls[0][0];
      expect(config.algorithms).toBeDefined();
      expect(config.algorithms.serverHostKey).toContain('rsa-sha2-256');
      expect(config.algorithms.serverHostKey).toContain('rsa-sha2-512');
    });

    it('includes modern kex algorithms in defaults', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
      const config = mockMethods.connect.mock.calls[0][0];
      expect(config.algorithms.kex).toContain('curve25519-sha256');
      expect(config.algorithms.kex).toContain('ecdh-sha2-nistp256');
    });

    it('passes custom algorithms when provided in server config', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      const customAlgorithms = {
        serverHostKey: ['ssh-ed25519'],
        kex: ['curve25519-sha256'],
      };
      const customConfig: ServerConfig = { ...serverConfig, algorithms: customAlgorithms };
      await service.connect(customConfig, { password: 'secret' });
      const config = mockMethods.connect.mock.calls[0][0];
      expect(config.algorithms.serverHostKey).toEqual(['ssh-ed25519']);
      expect(config.algorithms.kex).toEqual(['curve25519-sha256']);
    });

    it('connects with key auth reading a .pem file', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      const pemContent = Buffer.from('-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----');
      (fs.readFileSync as jest.Mock).mockReturnValue(pemContent);
      const keyConfig: ServerConfig = {
        ...serverConfig,
        authMethod: 'key',
        privateKeyPath: '/home/user/.ssh/ec2-key.pem',
      };
      await service.connect(keyConfig, {});
      expect(fs.readFileSync).toHaveBeenCalledWith('/home/user/.ssh/ec2-key.pem');
      expect(mockMethods.connect).toHaveBeenCalledWith(expect.objectContaining({
        privateKey: pemContent,
      }));
    });

    it('wraps key file read error with helpful message', async () => {
      const readError = new Error('ENOENT: no such file or directory');
      (fs.readFileSync as jest.Mock).mockImplementation(() => { throw readError; });
      const keyConfig: ServerConfig = {
        ...serverConfig,
        authMethod: 'key',
        privateKeyPath: '/home/user/.ssh/missing.pem',
      };
      await expect(service.connect(keyConfig, {}))
        .rejects.toThrow('Could not read private key file "/home/user/.ssh/missing.pem"');
    });

    it('wraps key parse error from ssh2 with helpful message', async () => {
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('not-a-valid-key'));
      mockMethods.connect.mockRejectedValue(new Error('Cannot parse privateKey'));
      const keyConfig: ServerConfig = {
        ...serverConfig,
        authMethod: 'key',
        privateKeyPath: '/home/user/.ssh/bad.pem',
      };
      await expect(service.connect(keyConfig, {}))
        .rejects.toThrow('Could not parse private key file. Supported formats: OpenSSH, PEM, PPK');
    });

    it('passes hostVerifier callback to ssh2 connect config', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      const hostVerifier = jest.fn().mockReturnValue(true);
      await service.connect(serverConfig, { password: 'secret' }, { hostVerifier });
      const config = mockMethods.connect.mock.calls[0][0];
      expect(config.hostVerifier).toBe(hostVerifier);
    });

    it('rejects connection when hostVerifier returns false', async () => {
      mockMethods.connect.mockImplementation((config: any) => {
        // Simulate ssh2 calling hostVerifier synchronously and rejecting
        if (config.hostVerifier && !config.hostVerifier('deadbeef')) {
          return Promise.reject(new Error('Handshake failed'));
        }
        return Promise.resolve();
      });
      const hostVerifier = jest.fn().mockReturnValue(false);
      await expect(service.connect(serverConfig, { password: 'secret' }, { hostVerifier }))
        .rejects.toThrow('Handshake failed');
      expect(hostVerifier).toHaveBeenCalled();
    });

    it('connects without hostVerifier when not provided', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
      const config = mockMethods.connect.mock.calls[0][0];
      expect(config.hostVerifier).toBeUndefined();
    });

    it('sets tryKeyboard true for keyboard-interactive auth', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      const kiConfig: ServerConfig = { ...serverConfig, authMethod: 'keyboard-interactive' };
      await service.connect(kiConfig, {}, { keyboardInteractiveHandler: jest.fn() });
      const config = mockMethods.connect.mock.calls[0][0];
      expect(config.tryKeyboard).toBe(true);
    });

    it('registers keyboard-interactive event handler on underlying client', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      const handler = jest.fn();
      const kiConfig: ServerConfig = { ...serverConfig, authMethod: 'keyboard-interactive' };
      await service.connect(kiConfig, {}, { keyboardInteractiveHandler: handler });
      expect(mockSsh2Client.on).toHaveBeenCalledWith(
        'keyboard-interactive',
        expect.any(Function)
      );
    });

    it('keyboard-interactive event forwards prompts to handler and sends responses', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      const handler = jest.fn().mockResolvedValue(['my-otp-code']);
      const kiConfig: ServerConfig = { ...serverConfig, authMethod: 'keyboard-interactive' };
      await service.connect(kiConfig, {}, { keyboardInteractiveHandler: handler });

      // Get the registered event callback
      const eventCall = mockSsh2Client.on.mock.calls.find(
        (call: any[]) => call[0] === 'keyboard-interactive'
      );
      const eventCallback = eventCall[1];

      // Simulate ssh2 emitting keyboard-interactive event
      const finish = jest.fn();
      await eventCallback('', 'SSH Server', '', [{ prompt: 'Verification code: ', echo: false }], finish);

      expect(handler).toHaveBeenCalledWith([{ prompt: 'Verification code: ', echo: false }]);
      expect(finish).toHaveBeenCalledWith(['my-otp-code']);
    });
  });

  describe('uploadFile', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      mockMethods.put.mockResolvedValue(undefined);
      mockMethods.mkdir.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('calls sftp.put with local path and temp remote path', async () => {
      mockMethods.posixRename.mockResolvedValue(undefined);
      await service.uploadFile('/local/src/index.php', '/var/www/src/index.php');
      expect(mockMethods.put).toHaveBeenCalledWith(
        '/local/src/index.php',
        '/var/www/src/index.php.fileferry.tmp'
      );
    });

    it('creates remote directory and retries when path does not exist', async () => {
      mockMethods.put
        .mockRejectedValueOnce({ code: 'ERR_BAD_PATH' })
        .mockResolvedValueOnce(undefined);
      mockMethods.posixRename.mockResolvedValue(undefined);
      await service.uploadFile('/local/src/new/index.php', '/var/www/src/new/index.php');
      expect(mockMethods.mkdir).toHaveBeenCalledWith('/var/www/src/new', true);
      expect(mockMethods.put).toHaveBeenCalledTimes(2);
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      mockMethods.connect.mockResolvedValue(undefined);
      await expect(fresh.uploadFile('/a', '/b')).rejects.toThrow('Not connected');
    });

    it('uploads to a temp file then posixRenames for atomic write', async () => {
      mockMethods.posixRename.mockResolvedValue(undefined);
      await service.uploadFile('/local/src/index.php', '/var/www/src/index.php');
      // Step 1: put to temp path
      expect(mockMethods.put).toHaveBeenCalledWith(
        '/local/src/index.php',
        '/var/www/src/index.php.fileferry.tmp'
      );
      // Step 2: posixRename temp → final (atomic overwrite)
      expect(mockMethods.posixRename).toHaveBeenCalledWith(
        '/var/www/src/index.php.fileferry.tmp',
        '/var/www/src/index.php'
      );
    });

    it('falls back to rename when posixRename is not supported', async () => {
      mockMethods.posixRename.mockRejectedValue(new Error('Not supported'));
      mockMethods.rename.mockResolvedValue(undefined);
      await service.uploadFile('/local/a.php', '/var/www/a.php');
      expect(mockMethods.posixRename).toHaveBeenCalledWith(
        '/var/www/a.php.fileferry.tmp',
        '/var/www/a.php'
      );
      expect(mockMethods.rename).toHaveBeenCalledWith(
        '/var/www/a.php.fileferry.tmp',
        '/var/www/a.php'
      );
    });

    it('does not rename when put to temp file fails', async () => {
      mockMethods.put.mockRejectedValue(new Error('Connection lost'));
      await expect(
        service.uploadFile('/local/a.php', '/var/www/a.php')
      ).rejects.toThrow('Connection lost');
      expect(mockMethods.posixRename).not.toHaveBeenCalled();
      expect(mockMethods.rename).not.toHaveBeenCalled();
    });

    it('cleans up temp file when both rename methods fail', async () => {
      mockMethods.posixRename.mockRejectedValue(new Error('Not supported'));
      mockMethods.rename.mockRejectedValue(new Error('Permission denied'));
      mockMethods.delete.mockResolvedValue(undefined);
      await expect(
        service.uploadFile('/local/a.php', '/var/www/a.php')
      ).rejects.toThrow('Permission denied');
      // Should try to delete the orphaned temp file
      expect(mockMethods.delete).toHaveBeenCalledWith(
        '/var/www/a.php.fileferry.tmp'
      );
    });

    it('creates directory and retries with temp file on ERR_BAD_PATH', async () => {
      mockMethods.put
        .mockRejectedValueOnce({ code: 'ERR_BAD_PATH' })
        .mockResolvedValueOnce(undefined);
      mockMethods.posixRename.mockResolvedValue(undefined);
      await service.uploadFile('/local/src/new/index.php', '/var/www/src/new/index.php');
      // mkdir for the real directory
      expect(mockMethods.mkdir).toHaveBeenCalledWith('/var/www/src/new', true);
      // Both put calls should target the temp path
      expect(mockMethods.put).toHaveBeenNthCalledWith(
        1,
        '/local/src/new/index.php',
        '/var/www/src/new/index.php.fileferry.tmp'
      );
      expect(mockMethods.put).toHaveBeenNthCalledWith(
        2,
        '/local/src/new/index.php',
        '/var/www/src/new/index.php.fileferry.tmp'
      );
      // posixRename after successful retry
      expect(mockMethods.posixRename).toHaveBeenCalledWith(
        '/var/www/src/new/index.php.fileferry.tmp',
        '/var/www/src/new/index.php'
      );
    });
  });

  describe('uploadFiles', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      mockMethods.put.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('uploads multiple files and returns succeeded list', async () => {
      const results = await service.uploadFiles([
        { localPath: '/local/a.php', remotePath: '/remote/a.php' },
        { localPath: '/local/b.php', remotePath: '/remote/b.php' },
      ], jest.fn());
      expect(results.succeeded).toHaveLength(2);
      expect(results.failed).toHaveLength(0);
    });

    it('continues uploading after individual file failure', async () => {
      mockMethods.put
        .mockRejectedValueOnce(new Error('Permission denied'))
        .mockResolvedValueOnce(undefined);
      const results = await service.uploadFiles([
        { localPath: '/local/a.php', remotePath: '/remote/a.php' },
        { localPath: '/local/b.php', remotePath: '/remote/b.php' },
      ], jest.fn());
      expect(results.failed).toHaveLength(1);
      expect(results.succeeded).toHaveLength(1);
      expect(results.failed[0].error).toBe('Permission denied');
    });

    it('calls progress callback for each file', async () => {
      const onProgress = jest.fn();
      await service.uploadFiles([
        { localPath: '/local/a.php', remotePath: '/remote/a.php' },
        { localPath: '/local/b.php', remotePath: '/remote/b.php' },
      ], onProgress);
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, 'a.php');
      expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, 'b.php');
    });
  });

  describe('get', () => {
    it('downloads remote file and returns a Buffer', async () => {
      const fakeContent = Buffer.from('<?php echo "hello"; ?>');
      mockMethods.connect.mockResolvedValue(undefined);
      mockMethods.get = jest.fn().mockResolvedValue(fakeContent);
      await service.connect(serverConfig, { password: 'secret' });
      const result = await service.get('/var/www/index.php');
      expect(mockMethods.get).toHaveBeenCalledWith('/var/www/index.php');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('<?php echo "hello"; ?>');
    });

    it('converts string result to Buffer', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      mockMethods.get = jest.fn().mockResolvedValue('string content');
      await service.connect(serverConfig, { password: 'secret' });
      const result = await service.get('/var/www/index.php');
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.get('/var/www/index.php')).rejects.toThrow('Not connected');
    });
  });

  describe('listDirectory', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('returns directories and files from the remote path', async () => {
      mockMethods.list.mockResolvedValue([
        { name: 'html', type: 'd' },
        { name: 'logs', type: 'd' },
        { name: '.htaccess', type: '-' },
      ]);
      const result = await service.listDirectory('/var/www');
      expect(mockMethods.list).toHaveBeenCalledWith('/var/www');
      expect(result).toEqual([
        { name: 'html', type: 'd' },
        { name: 'logs', type: 'd' },
        { name: '.htaccess', type: '-' },
      ]);
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.listDirectory('/var/www')).rejects.toThrow('Not connected');
    });
  });

  describe('resolveRemotePath', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('returns the resolved absolute path from the server', async () => {
      mockMethods.realPath.mockResolvedValue('/home/deploy');
      const result = await service.resolveRemotePath('.');
      expect(mockMethods.realPath).toHaveBeenCalledWith('.');
      expect(result).toBe('/home/deploy');
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.resolveRemotePath('.')).rejects.toThrow('Not connected');
    });
  });

  describe('deleteFile', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('calls sftp.delete with the remote path', async () => {
      mockMethods.delete.mockResolvedValue(undefined);
      await service.deleteFile('/var/www/src/old.php');
      expect(mockMethods.delete).toHaveBeenCalledWith('/var/www/src/old.php');
    });

    it('propagates deletion errors', async () => {
      mockMethods.delete.mockRejectedValue(new Error('No such file'));
      await expect(service.deleteFile('/var/www/src/gone.php')).rejects.toThrow('No such file');
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.deleteFile('/var/www/src/old.php')).rejects.toThrow('Not connected');
    });
  });

  describe('listDirectoryDetailed', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('returns full FileInfo objects from the remote path', async () => {
      mockMethods.list.mockResolvedValue([
        { name: 'logs', type: 'd', size: 4096, modifyTime: 1710000000000, accessTime: 1710000000000, rights: { user: 'rwx' }, owner: 1000, group: 1000 },
        { name: 'app.log', type: '-', size: 52428, modifyTime: 1710100000000, accessTime: 1710100000000, rights: { user: 'rw-' }, owner: 1000, group: 1000 },
      ]);
      const result = await service.listDirectoryDetailed('/var/log');
      expect(mockMethods.list).toHaveBeenCalledWith('/var/log');
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('size', 4096);
      expect(result[0]).toHaveProperty('modifyTime', 1710000000000);
      expect(result[1]).toHaveProperty('name', 'app.log');
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.listDirectoryDetailed('/var/log')).rejects.toThrow('Not connected');
    });
  });

  describe('connected', () => {
    it('returns false before connecting', () => {
      const fresh = new SftpService();
      expect(fresh.connected).toBe(false);
    });

    it('returns true after connecting', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
      expect(service.connected).toBe(true);
    });

    it('returns false after disconnecting', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      mockMethods.end.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
      await service.disconnect();
      expect(service.connected).toBe(false);
    });
  });

  describe('deleteDirectory', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('calls rmdir with recursive true', async () => {
      mockMethods.rmdir.mockResolvedValue(undefined);
      await service.deleteDirectory('/var/www/old-folder');
      expect(mockMethods.rmdir).toHaveBeenCalledWith('/var/www/old-folder', true);
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.deleteDirectory('/var/www/old-folder')).rejects.toThrow('Not connected');
    });
  });

  describe('statType', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('returns d when remote path is a directory', async () => {
      mockMethods.stat.mockResolvedValue({ isDirectory: true });
      const result = await service.statType('/var/www/uploads');
      expect(mockMethods.stat).toHaveBeenCalledWith('/var/www/uploads');
      expect(result).toBe('d');
    });

    it('returns - when remote path is a regular file', async () => {
      mockMethods.stat.mockResolvedValue({ isDirectory: false });
      const result = await service.statType('/var/www/index.php');
      expect(result).toBe('-');
    });

    it('returns null when file does not exist (code 2)', async () => {
      mockMethods.stat.mockRejectedValue({ code: 2, message: 'No such file' });
      const result = await service.statType('/var/www/missing');
      expect(result).toBeNull();
    });

    it('returns null on permission denied', async () => {
      mockMethods.stat.mockRejectedValue(new Error('Permission denied'));
      const result = await service.statType('/var/www/secret');
      expect(result).toBeNull();
    });

    it('returns null on ELOOP (circular symlink)', async () => {
      mockMethods.stat.mockRejectedValue({ code: 'ELOOP', message: 'Too many levels of symbolic links' });
      const result = await service.statType('/var/www/circular');
      expect(result).toBeNull();
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.statType('/var/www')).rejects.toThrow('Not connected');
    });
  });

  describe('stat', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('returns mtime for an existing remote file', async () => {
      const mtime = new Date('2026-04-01T12:00:00Z');
      mockMethods.stat.mockResolvedValue({ mtime: mtime.getTime() / 1000 });
      const result = await service.stat('/var/www/index.php');
      expect(mockMethods.stat).toHaveBeenCalledWith('/var/www/index.php');
      expect(result).toEqual({ mtime });
    });

    it('returns null when remote file does not exist', async () => {
      mockMethods.stat.mockRejectedValue({ code: 2, message: 'No such file' });
      const result = await service.stat('/var/www/missing.php');
      expect(result).toBeNull();
    });

    it('propagates unexpected errors', async () => {
      mockMethods.stat.mockRejectedValue(new Error('Permission denied'));
      await expect(service.stat('/var/www/secret.php')).rejects.toThrow('Permission denied');
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.stat('/var/www/index.php')).rejects.toThrow('Not connected');
    });
  });

  describe('disconnect', () => {
    it('calls end on the client', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      mockMethods.end.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
      await service.disconnect();
      expect(mockMethods.end).toHaveBeenCalled();
    });
  });

  describe('chmod', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('calls chmod on the underlying client with the given mode', async () => {
      mockMethods.chmod.mockResolvedValue(undefined);
      await service.chmod('/var/www/index.php', 0o644);
      expect(mockMethods.chmod).toHaveBeenCalledWith('/var/www/index.php', 0o644);
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      await expect(fresh.chmod('/var/www/index.php', 0o644)).rejects.toThrow('Not connected');
    });
  });
});
