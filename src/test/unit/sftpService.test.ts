import { SftpService } from '../../sftpService';
import { ServerConfig } from '../../types';

// Mock ssh2-sftp-client (the module's default export is the client class)
const mockClient = {
  connect: jest.fn(),
  mkdir: jest.fn(),
  stat: jest.fn(),
  end: jest.fn(),
};

jest.mock('ssh2-sftp-client', () => jest.fn().mockImplementation(() => mockClient));

const server: ServerConfig = {
  id: 'unit-sftp',
  name: 'Unit SFTP',
  type: 'sftp',
  host: 'sftp.example.com',
  port: 22,
  username: 'user',
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

describe('SftpService', () => {
  let service: SftpService;

  beforeEach(() => {
    service = new SftpService();
    jest.clearAllMocks();
  });

  async function connect(): Promise<void> {
    await service.connect(server, { password: 'pass' });
  }

  describe('mkdir', () => {
    it('throws when not connected', async () => {
      await expect(service.mkdir('/remote/newdir')).rejects.toThrow('Not connected');
      expect(mockClient.mkdir).not.toHaveBeenCalled();
    });

    it('creates the directory non-recursively by default', async () => {
      await connect();
      await service.mkdir('/remote/newdir');
      expect(mockClient.mkdir).toHaveBeenCalledWith('/remote/newdir', false);
    });

    it('creates missing parents when recursive is requested', async () => {
      await connect();
      await service.mkdir('/remote/a/b/c', true);
      expect(mockClient.mkdir).toHaveBeenCalledWith('/remote/a/b/c', true);
    });

    it('propagates the underlying error', async () => {
      await connect();
      mockClient.mkdir.mockRejectedValueOnce(new Error('Permission denied'));
      await expect(service.mkdir('/remote/newdir')).rejects.toThrow('Permission denied');
    });
  });

  describe('exists', () => {
    it('throws when not connected', async () => {
      await expect(service.exists('/remote/thing')).rejects.toThrow('Not connected');
    });

    it('returns true for an existing directory', async () => {
      await connect();
      mockClient.stat.mockResolvedValueOnce({ isDirectory: true, modifyTime: 1000 });
      await expect(service.exists('/remote/dir')).resolves.toBe(true);
    });

    it('returns true for an existing file', async () => {
      await connect();
      mockClient.stat.mockResolvedValueOnce({ isDirectory: false, modifyTime: 1000 });
      await expect(service.exists('/remote/file.txt')).resolves.toBe(true);
    });

    it('returns false when the path does not exist', async () => {
      await connect();
      mockClient.stat.mockRejectedValueOnce(Object.assign(new Error('No such file'), { code: 'ENOENT' }));
      await expect(service.exists('/remote/missing')).resolves.toBe(false);
    });
  });
});
