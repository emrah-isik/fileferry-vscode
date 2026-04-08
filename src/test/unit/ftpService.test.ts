import { FtpService } from '../../ftpService';
import { TransferService } from '../../transferService';

// Mock basic-ftp Client
const mockClient = {
  access: jest.fn(),
  uploadFrom: jest.fn(),
  downloadTo: jest.fn(),
  list: jest.fn(),
  rename: jest.fn(),
  remove: jest.fn(),
  removeDir: jest.fn(),
  ensureDir: jest.fn(),
  pwd: jest.fn(),
  cd: jest.fn(),
  send: jest.fn(),
  close: jest.fn(),
  ftp: { socket: { remoteAddress: '1.2.3.4' } },
  closed: false,
};

jest.mock('basic-ftp', () => ({
  Client: jest.fn().mockImplementation(() => mockClient),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn().mockReturnValue('mock-read-stream'),
}));

describe('FtpService', () => {
  let service: FtpService;

  beforeEach(() => {
    service = new FtpService();
    jest.clearAllMocks();
    mockClient.closed = false;
  });

  describe('interface conformance', () => {
    it('satisfies TransferService', () => {
      const svc: TransferService = service;
      expect(svc).toBeDefined();
      expect(typeof svc.connect).toBe('function');
      expect(typeof svc.uploadFile).toBe('function');
      expect(typeof svc.get).toBe('function');
      expect(typeof svc.listDirectory).toBe('function');
      expect(typeof svc.listDirectoryDetailed).toBe('function');
      expect(typeof svc.resolveRemotePath).toBe('function');
      expect(typeof svc.statType).toBe('function');
      expect(typeof svc.stat).toBe('function');
      expect(typeof svc.deleteFile).toBe('function');
      expect(typeof svc.deleteDirectory).toBe('function');
      expect(typeof svc.disconnect).toBe('function');
    });
  });

  describe('connected', () => {
    it('returns false before connect', () => {
      expect(service.connected).toBe(false);
    });

    it('returns true after connect', async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
      expect(service.connected).toBe(true);
    });
  });

  describe('connect', () => {
    it('connects with plain FTP (no TLS)', async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
      expect(mockClient.access).toHaveBeenCalledWith({
        host: 'ftp.example.com',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false,
      });
    });

    it('connects with explicit FTPS', async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftps' },
        { password: 'pass' }
      );
      expect(mockClient.access).toHaveBeenCalledWith({
        host: 'ftp.example.com',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: true,
      });
    });

    it('connects with implicit FTPS (port 990)', async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 990, username: 'user', type: 'ftps-implicit' },
        { password: 'pass' }
      );
      expect(mockClient.access).toHaveBeenCalledWith({
        host: 'ftp.example.com',
        port: 990,
        user: 'user',
        password: 'pass',
        secure: 'implicit',
      });
    });

    it('ignores hostVerifier and keyboardInteractiveHandler options', async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' },
        {
          hostVerifier: () => true,
          keyboardInteractiveHandler: async () => [],
        }
      );
      expect(mockClient.access).toHaveBeenCalled();
    });

    it('throws on connection failure', async () => {
      mockClient.access.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(
        service.connect(
          { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
          { password: 'pass' }
        )
      ).rejects.toThrow('Connection refused');
    });
  });

  describe('uploadFile', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('throws if not connected', async () => {
      const svc = new FtpService();
      await expect(svc.uploadFile('/local/file.txt', '/remote/file.txt'))
        .rejects.toThrow('Not connected');
    });

    it('uploads to temp file then renames (atomic)', async () => {
      await service.uploadFile('/local/file.txt', '/remote/file.txt');
      expect(mockClient.uploadFrom).toHaveBeenCalledWith(
        'mock-read-stream',
        '/remote/file.txt.fileferry.tmp'
      );
      expect(mockClient.rename).toHaveBeenCalledWith(
        '/remote/file.txt.fileferry.tmp',
        '/remote/file.txt'
      );
    });

    it('creates parent directory and retries on upload failure', async () => {
      mockClient.uploadFrom
        .mockRejectedValueOnce(new Error('550 No such file or directory'))
        .mockResolvedValueOnce(undefined);
      await service.uploadFile('/local/file.txt', '/remote/deep/file.txt');
      expect(mockClient.ensureDir).toHaveBeenCalledWith('/remote/deep');
      expect(mockClient.uploadFrom).toHaveBeenCalledTimes(2);
    });

    it('cleans up temp file if rename fails', async () => {
      mockClient.rename.mockRejectedValueOnce(new Error('rename failed'));
      await expect(service.uploadFile('/local/f.txt', '/remote/f.txt'))
        .rejects.toThrow('rename failed');
      expect(mockClient.remove).toHaveBeenCalledWith('/remote/f.txt.fileferry.tmp');
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('throws if not connected', async () => {
      const svc = new FtpService();
      await expect(svc.get('/remote/file.txt')).rejects.toThrow('Not connected');
    });

    it('downloads file to buffer', async () => {
      // downloadTo with a writable stream that captures data
      mockClient.downloadTo.mockImplementation(async (writable: any) => {
        writable.write(Buffer.from('hello'));
        writable.end();
      });
      const buf = await service.get('/remote/file.txt');
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.toString()).toBe('hello');
    });
  });

  describe('listDirectory', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('throws if not connected', async () => {
      const svc = new FtpService();
      await expect(svc.listDirectory('/remote')).rejects.toThrow('Not connected');
    });

    it('returns name and type for each entry', async () => {
      mockClient.list.mockResolvedValueOnce([
        { name: 'docs', type: 2, size: 4096, modifiedAt: new Date('2026-01-01'), isDirectory: true, isFile: false, isSymbolicLink: false },
        { name: 'readme.md', type: 1, size: 100, modifiedAt: new Date('2026-01-02'), isDirectory: false, isFile: true, isSymbolicLink: false },
      ]);
      const result = await service.listDirectory('/remote');
      expect(result).toEqual([
        { name: 'docs', type: 'd' },
        { name: 'readme.md', type: '-' },
      ]);
    });

    it('maps symbolic links to type l', async () => {
      mockClient.list.mockResolvedValueOnce([
        { name: 'link', type: 3, size: 0, modifiedAt: new Date(), isDirectory: false, isFile: false, isSymbolicLink: true },
      ]);
      const result = await service.listDirectory('/remote');
      expect(result).toEqual([{ name: 'link', type: 'l' }]);
    });
  });

  describe('listDirectoryDetailed', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('returns FileEntry objects', async () => {
      const modDate = new Date('2026-03-15T10:00:00Z');
      mockClient.list.mockResolvedValueOnce([
        { name: 'file.txt', type: 1, size: 500, modifiedAt: modDate, isDirectory: false, isFile: true, isSymbolicLink: false },
      ]);
      const result = await service.listDirectoryDetailed('/remote');
      expect(result).toEqual([
        { name: 'file.txt', type: '-', size: 500, modifyTime: modDate.getTime() },
      ]);
    });
  });

  describe('resolveRemotePath', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('uses pwd for "." path', async () => {
      mockClient.pwd.mockResolvedValueOnce('/home/user');
      const result = await service.resolveRemotePath('.');
      expect(result).toBe('/home/user');
    });

    it('returns absolute paths as-is', async () => {
      const result = await service.resolveRemotePath('/var/www');
      expect(result).toBe('/var/www');
    });
  });

  describe('statType', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('returns d for directories', async () => {
      mockClient.cd.mockResolvedValueOnce(undefined);
      const result = await service.statType('/remote/dir');
      expect(result).toBe('d');
    });

    it('returns - for files (cd fails)', async () => {
      mockClient.cd.mockRejectedValueOnce(new Error('not a directory'));
      mockClient.list.mockResolvedValueOnce([
        { name: 'file.txt', type: 1, size: 100, modifiedAt: new Date(), isDirectory: false, isFile: true, isSymbolicLink: false },
      ]);
      const result = await service.statType('/remote/dir/file.txt');
      expect(result).toBe('-');
    });

    it('returns null if path does not exist', async () => {
      mockClient.cd.mockRejectedValueOnce(new Error('not a directory'));
      mockClient.list.mockResolvedValueOnce([]);
      const result = await service.statType('/remote/nonexistent');
      expect(result).toBe(null);
    });
  });

  describe('stat', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('returns mtime for existing file', async () => {
      const modDate = new Date('2026-03-15T10:00:00Z');
      mockClient.list.mockResolvedValueOnce([
        { name: 'file.txt', type: 1, size: 100, modifiedAt: modDate, isDirectory: false, isFile: true, isSymbolicLink: false },
      ]);
      const result = await service.stat('/remote/dir/file.txt');
      expect(result).toEqual({ mtime: modDate });
    });

    it('returns null for non-existent file', async () => {
      mockClient.list.mockResolvedValueOnce([]);
      const result = await service.stat('/remote/dir/missing.txt');
      expect(result).toBe(null);
    });

    it('returns null when list throws', async () => {
      mockClient.list.mockRejectedValueOnce(new Error('550'));
      const result = await service.stat('/remote/dir/file.txt');
      expect(result).toBe(null);
    });
  });

  describe('deleteFile', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('throws if not connected', async () => {
      const svc = new FtpService();
      await expect(svc.deleteFile('/remote/file.txt')).rejects.toThrow('Not connected');
    });

    it('deletes a remote file', async () => {
      await service.deleteFile('/remote/file.txt');
      expect(mockClient.remove).toHaveBeenCalledWith('/remote/file.txt');
    });
  });

  describe('deleteDirectory', () => {
    beforeEach(async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
    });

    it('removes a remote directory', async () => {
      await service.deleteDirectory('/remote/dir');
      expect(mockClient.removeDir).toHaveBeenCalledWith('/remote/dir');
    });
  });

  describe('disconnect', () => {
    it('closes the client', async () => {
      await service.connect(
        { host: 'ftp.example.com', port: 21, username: 'user', type: 'ftp' },
        { password: 'pass' }
      );
      await service.disconnect();
      expect(mockClient.close).toHaveBeenCalled();
      expect(service.connected).toBe(false);
    });

    it('is safe to call when not connected', async () => {
      await service.disconnect();
      expect(service.connected).toBe(false);
    });
  });
});
