import { SftpService } from '../../sftpService';
import { ServerConfig } from '../../types';

// Mock ssh2-sftp-client (the module's default export is the client class)
const mockClient = {
  connect: jest.fn(),
  mkdir: jest.fn(),
  stat: jest.fn(),
  list: jest.fn(),
  posixRename: jest.fn(),
  rename: jest.fn(),
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

  describe('listDirectoryDetailed', () => {
    it('throws when not connected', async () => {
      await expect(service.listDirectoryDetailed('/remote')).rejects.toThrow('Not connected');
    });

    function fileInfo(rights: { user: string; group: string; other: string }) {
      return {
        name: 'file.txt', type: '-', size: 500, modifyTime: 1710000000000,
        accessTime: 1710000000000, rights, owner: 1000, group: 1000,
      };
    }

    it.each([
      [{ user: 'rw', group: 'r', other: 'r' }, '644'],
      [{ user: 'rwx', group: 'rx', other: 'rx' }, '755'],
      [{ user: 'rw', group: '', other: '' }, '600'],
      [{ user: '', group: '', other: '' }, '000'],
    ])('derives the octal mode from rights %j → %s', async (rights, expected) => {
      await connect();
      mockClient.list.mockResolvedValueOnce([fileInfo(rights as { user: string; group: string; other: string })]);
      const result = await service.listDirectoryDetailed('/remote');
      expect(result[0].mode).toBe(expected);
    });

    it('maps setgid/setuid rights (lowercase s counts as execute + special bit)', async () => {
      await connect();
      mockClient.list.mockResolvedValueOnce([fileInfo({ user: 'rwx', group: 'rws', other: 'rx' })]);
      const result = await service.listDirectoryDetailed('/remote');
      expect(result[0].mode).toBe('2775');
    });

    it('keeps the FileEntry fields alongside the mode', async () => {
      await connect();
      mockClient.list.mockResolvedValueOnce([fileInfo({ user: 'rw', group: 'r', other: 'r' })]);
      const result = await service.listDirectoryDetailed('/remote');
      expect(result[0]).toEqual(
        expect.objectContaining({ name: 'file.txt', type: '-', size: 500, modifyTime: 1710000000000 })
      );
    });

    it('leaves mode undefined when the listing carries no rights', async () => {
      await connect();
      mockClient.list.mockResolvedValueOnce([
        { name: 'file.txt', type: '-', size: 500, modifyTime: 1710000000000 },
      ]);
      const result = await service.listDirectoryDetailed('/remote');
      expect(result[0].mode).toBeUndefined();
    });
  });

  describe('rename', () => {
    it('throws when not connected', async () => {
      await expect(service.rename('/remote/old.txt', '/remote/new.txt')).rejects.toThrow('Not connected');
      expect(mockClient.posixRename).not.toHaveBeenCalled();
      expect(mockClient.rename).not.toHaveBeenCalled();
    });

    it('uses the POSIX rename extension when the server supports it', async () => {
      await connect();
      await service.rename('/remote/old.txt', '/remote/new.txt');
      expect(mockClient.posixRename).toHaveBeenCalledWith('/remote/old.txt', '/remote/new.txt');
      expect(mockClient.rename).not.toHaveBeenCalled();
    });

    it('falls back to regular rename when posixRename fails', async () => {
      await connect();
      mockClient.posixRename.mockRejectedValueOnce(new Error('Server does not support posix-rename@openssh.com'));
      await service.rename('/remote/old.txt', '/remote/new.txt');
      expect(mockClient.rename).toHaveBeenCalledWith('/remote/old.txt', '/remote/new.txt');
    });

    it('propagates the fallback error when both attempts fail', async () => {
      await connect();
      mockClient.posixRename.mockRejectedValueOnce(new Error('unsupported'));
      mockClient.rename.mockRejectedValueOnce(new Error('Permission denied'));
      await expect(service.rename('/remote/old.txt', '/remote/new.txt')).rejects.toThrow('Permission denied');
    });
  });
});
