import { SftpService } from '../sftpService';
import { ServerConfig } from '../types';

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
};

jest.mock('ssh2-sftp-client', () => {
  return jest.fn().mockImplementation(() => mockMethods);
});

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

    it('connects with agent auth', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      const agentConfig: ServerConfig = { ...serverConfig, authMethod: 'agent' };
      await service.connect(agentConfig, {});
      expect(mockMethods.connect).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.anything()
      }));
    });

    it('throws on connection failure', async () => {
      mockMethods.connect.mockRejectedValue(new Error('Connection refused'));
      await expect(service.connect(serverConfig, { password: 'x' }))
        .rejects.toThrow('Connection refused');
    });
  });

  describe('uploadFile', () => {
    beforeEach(async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      mockMethods.put.mockResolvedValue(undefined);
      mockMethods.mkdir.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
    });

    it('calls sftp.put with local and remote paths', async () => {
      await service.uploadFile('/local/src/index.php', '/var/www/src/index.php');
      expect(mockMethods.put).toHaveBeenCalledWith(
        '/local/src/index.php',
        '/var/www/src/index.php'
      );
    });

    it('creates remote directory and retries when path does not exist', async () => {
      mockMethods.put
        .mockRejectedValueOnce({ code: 'ERR_BAD_PATH' })
        .mockResolvedValueOnce(undefined);
      await service.uploadFile('/local/src/new/index.php', '/var/www/src/new/index.php');
      expect(mockMethods.mkdir).toHaveBeenCalledWith('/var/www/src/new', true);
      expect(mockMethods.put).toHaveBeenCalledTimes(2);
    });

    it('throws if not connected', async () => {
      const fresh = new SftpService();
      mockMethods.connect.mockResolvedValue(undefined);
      await expect(fresh.uploadFile('/a', '/b')).rejects.toThrow('Not connected');
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

  describe('disconnect', () => {
    it('calls end on the client', async () => {
      mockMethods.connect.mockResolvedValue(undefined);
      mockMethods.end.mockResolvedValue(undefined);
      await service.connect(serverConfig, { password: 'secret' });
      await service.disconnect();
      expect(mockMethods.end).toHaveBeenCalled();
    });
  });
});
