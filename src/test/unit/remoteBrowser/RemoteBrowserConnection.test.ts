import { RemoteBrowserConnection } from '../../../remoteBrowser/RemoteBrowserConnection';

jest.mock('../../../transferServiceFactory');

import { createTransferService } from '../../../transferServiceFactory';

const mockSftp = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  listDirectoryDetailed: jest.fn(),
  get: jest.fn(),
  uploadFile: jest.fn(),
  stat: jest.fn(),
  deleteFile: jest.fn(),
  deleteDirectory: jest.fn(),
  rename: jest.fn(),
  chmod: jest.fn(),
  statType: jest.fn(),
  mkdir: jest.fn(),
  exists: jest.fn(),
  connected: false,
  routeKeys: [] as string[],
};

(createTransferService as jest.Mock).mockReturnValue(mockSftp);

type CredentialChangeListener = (event: { id: string; kind: 'save' | 'delete' }) => unknown;
const credentialChangeListeners: CredentialChangeListener[] = [];
const fireCredentialChange = async (event: { id: string; kind: 'save' | 'delete' }) => {
  for (const listener of [...credentialChangeListeners]) { await listener(event); }
};

const mockCredentialManager = {
  getWithSecret: jest.fn(),
  getAll: jest.fn().mockResolvedValue([]),
  onDidChange: (listener: CredentialChangeListener) => {
    credentialChangeListeners.push(listener);
    return { dispose: () => { const i = credentialChangeListeners.indexOf(listener); if (i >= 0) { credentialChangeListeners.splice(i, 1); } } };
  },
};

type SaveListener = () => void;
const saveListeners: SaveListener[] = [];
const fireOnDidSaveConfig = async () => {
  for (const listener of [...saveListeners]) { await listener(); }
};

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
  onDidSaveConfig: (listener: SaveListener) => {
    saveListeners.push(listener);
    return { dispose: () => { const i = saveListeners.indexOf(listener); if (i >= 0) { saveListeners.splice(i, 1); } } };
  },
};

const mockOutput = {
  appendLine: jest.fn(),
};

const fakeServer = {
  id: 'server-1',
  type: 'sftp' as const,
  credentialId: 'cred-1',
  credentialName: 'Deploy Key',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: '/var/www' }],
  excludedPaths: [],
};

const fakeCredential = {
  id: 'cred-1',
  name: 'Deploy Key',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password' as const,
  password: 'secret',
};

const fakeConfig = {
  defaultServerId: 'server-1',
  servers: { Production: fakeServer },
};

describe('RemoteBrowserConnection', () => {
  let connection: RemoteBrowserConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    saveListeners.length = 0;
    credentialChangeListeners.length = 0;
    mockSftp.connected = false;
    mockSftp.routeKeys = [];
    mockConfigManager.getConfig.mockResolvedValue(fakeConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: fakeServer });
    mockCredentialManager.getWithSecret.mockResolvedValue(fakeCredential);
    mockSftp.connect.mockResolvedValue(undefined);
    mockSftp.disconnect.mockResolvedValue(undefined);

    connection = new RemoteBrowserConnection(
      mockCredentialManager as any,
      mockConfigManager as any,
      mockOutput as any
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('ensureConnected', () => {
    it('resolves server from config and connects', async () => {
      await connection.ensureConnected();
      expect(mockConfigManager.getConfig).toHaveBeenCalled();
      expect(mockConfigManager.getServerById).toHaveBeenCalledWith('server-1');
      expect(mockCredentialManager.getWithSecret).toHaveBeenCalledWith('cred-1');
      expect(mockSftp.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'example.com',
          port: 22,
          username: 'deploy',
          authMethod: 'password',
        }),
        expect.objectContaining({ password: 'secret' }),
        expect.objectContaining({ interactive: true })
      );
    });

    it('rebuild carries agentSocketPath and jumpHosts through to the ServerConfig (18a-2a, C4/R8-17)', async () => {
      mockCredentialManager.getWithSecret.mockResolvedValue({
        ...fakeCredential,
        authMethod: 'agent' as const,
        agentSocketPath: '/run/user/1000/custom-agent.sock',
        jumpHosts: ['cred-bastion'],
      });
      await connection.ensureConnected();
      expect(mockSftp.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSocketPath: '/run/user/1000/custom-agent.sock',
          jumpHosts: ['cred-bastion'],
        }),
        expect.anything(),
        expect.anything()
      );
    });

    it('forwards interactive:false to the connect (18a-1b)', async () => {
      await connection.ensureConnected({ interactive: false });
      expect(mockSftp.connect).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ interactive: false })
      );
    });

    it.each([
      ['statRemote', () => connection.statRemote('/var/www/x', { interactive: false })],
      ['downloadFile', () => connection.downloadFile('/var/www/x', { interactive: false })],
      ['uploadFile', () => connection.uploadFile('/tmp/x', '/var/www/x', { interactive: false })],
    ] as const)('%s forwards interactive:false to the connect it triggers (18a-1b)', async (_name, run) => {
      mockSftp.stat.mockResolvedValue(null);
      mockSftp.get.mockResolvedValue(Buffer.from(''));
      mockSftp.uploadFile.mockResolvedValue(undefined);

      await run();

      expect(mockSftp.connect).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ interactive: false })
      );
    });

    it('passes the credential useSshConfig flag through to the connect server config', async () => {
      mockCredentialManager.getWithSecret.mockResolvedValue({ ...fakeCredential, host: 'prod', useSshConfig: true });
      await connection.ensureConnected();
      expect(mockSftp.connect).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'prod', useSshConfig: true }),
        expect.anything(),
        expect.anything()
      );
    });

    it('is a no-op when already connected to the same server', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.connect.mockClear();

      await connection.ensureConnected();
      expect(mockSftp.connect).not.toHaveBeenCalled();
    });

    it('disconnects and reconnects when server changes', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;

      const newServer = { ...fakeServer, id: 'server-2', credentialId: 'cred-2' };
      const newCredential = { ...fakeCredential, id: 'cred-2', host: 'staging.example.com' };
      const newConfig = { defaultServerId: 'server-2', servers: { Staging: newServer } };

      mockConfigManager.getConfig.mockResolvedValue(newConfig);
      mockConfigManager.getServerById.mockResolvedValue({ name: 'Staging', server: newServer });
      mockCredentialManager.getWithSecret.mockResolvedValue(newCredential);

      await connection.ensureConnected();
      expect(mockSftp.disconnect).toHaveBeenCalled();
      expect(mockSftp.connect).toHaveBeenCalledTimes(2);
    });

    it('throws when no config exists', async () => {
      mockConfigManager.getConfig.mockResolvedValue(null);
      await expect(connection.ensureConnected()).rejects.toThrow(/no server configured/i);
    });

    it('throws when server not found', async () => {
      mockConfigManager.getServerById.mockResolvedValue(undefined);
      await expect(connection.ensureConnected()).rejects.toThrow(/server not found/i);
    });
  });

  describe('listDirectory', () => {
    it('ensures connection and delegates to sftp', async () => {
      const fakeFiles = [
        { name: 'logs', type: 'd', size: 4096, modifyTime: 1710000000000 },
      ];
      mockSftp.listDirectoryDetailed.mockResolvedValue(fakeFiles);

      const result = await connection.listDirectory('/var/log');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.listDirectoryDetailed).toHaveBeenCalledWith('/var/log');
      expect(result).toEqual(fakeFiles);
    });
  });

  describe('downloadFile', () => {
    it('ensures connection and delegates to sftp', async () => {
      const fakeBuffer = Buffer.from('log content');
      mockSftp.get.mockResolvedValue(fakeBuffer);

      const result = await connection.downloadFile('/var/log/app.log');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.get).toHaveBeenCalledWith('/var/log/app.log');
      expect(result).toEqual(fakeBuffer);
    });
  });

  describe('getCurrentServerId', () => {
    it('returns null before connecting', () => {
      expect(connection.getCurrentServerId()).toBeNull();
    });

    it('returns the connected server id after ensureConnected', async () => {
      await connection.ensureConnected();
      expect(connection.getCurrentServerId()).toBe('server-1');
    });

    it('returns null again after disconnect', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;

      await connection.disconnect();
      expect(connection.getCurrentServerId()).toBeNull();
    });
  });

  describe('uploadFile', () => {
    it('ensures connection and delegates to sftp uploadFile', async () => {
      mockSftp.uploadFile.mockResolvedValue(undefined);

      await connection.uploadFile('/tmp/fileferry-browse/app.remote.abc123.log', '/var/log/app.log');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.uploadFile).toHaveBeenCalledWith(
        '/tmp/fileferry-browse/app.remote.abc123.log',
        '/var/log/app.log'
      );
    });

    it('resets the idle timer', async () => {
      mockSftp.uploadFile.mockResolvedValue(undefined);
      mockSftp.listDirectoryDetailed.mockResolvedValue([]);

      await connection.listDirectory('/var/log');
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      jest.advanceTimersByTime(4 * 60 * 1000);
      await connection.uploadFile('/tmp/edit.txt', '/var/log/app.log');
      mockSftp.disconnect.mockClear();

      // 4 minutes after the upload — timer was reset, still connected
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(mockSftp.disconnect).not.toHaveBeenCalled();

      // 5 minutes after the upload — idle timeout fires
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });
  });

  describe('statRemote', () => {
    it('ensures connection and delegates to sftp stat', async () => {
      const mtime = new Date('2026-07-12T10:00:00Z');
      mockSftp.stat.mockResolvedValue({ mtime });

      const result = await connection.statRemote('/var/log/app.log');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.stat).toHaveBeenCalledWith('/var/log/app.log');
      expect(result).toEqual({ mtime });
    });

    it('passes through null when the remote file does not exist', async () => {
      mockSftp.stat.mockResolvedValue(null);

      const result = await connection.statRemote('/var/log/gone.log');
      expect(result).toBeNull();
    });
  });

  describe('idle timeout', () => {
    it('disconnects after 5 minutes of inactivity', async () => {
      await connection.listDirectory('/var/log');
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });

    it('resets timer on each operation', async () => {
      mockSftp.listDirectoryDetailed.mockResolvedValue([]);
      await connection.listDirectory('/var/log');
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      // Advance 4 minutes, then do another operation
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(mockSftp.disconnect).not.toHaveBeenCalled();

      await connection.listDirectory('/var/log');
      mockSftp.disconnect.mockClear();

      // Advance another 4 minutes — should not disconnect yet (timer was reset)
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(mockSftp.disconnect).not.toHaveBeenCalled();

      // Advance 1 more minute (total 5 since last operation) — should disconnect
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('disconnects sftp and clears timer', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      await connection.disconnect();
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });
  });

  describe('createDirectory', () => {
    it('ensures connection and delegates to sftp mkdir non-recursively', async () => {
      mockSftp.mkdir.mockResolvedValue(undefined);
      await connection.createDirectory('/var/www/newdir');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.mkdir).toHaveBeenCalledWith('/var/www/newdir');
    });

    it('propagates the underlying error', async () => {
      mockSftp.mkdir.mockRejectedValue(new Error('Permission denied'));
      await expect(connection.createDirectory('/var/www/newdir')).rejects.toThrow('Permission denied');
    });

    it('resets the idle timer', async () => {
      mockSftp.mkdir.mockResolvedValue(undefined);
      mockSftp.listDirectoryDetailed.mockResolvedValue([]);

      await connection.listDirectory('/var/www');
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      jest.advanceTimersByTime(4 * 60 * 1000);
      await connection.createDirectory('/var/www/newdir');
      mockSftp.disconnect.mockClear();

      // 4 minutes after the mkdir — timer was reset, still connected
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(mockSftp.disconnect).not.toHaveBeenCalled();

      // 5 minutes after the mkdir — idle timeout fires
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });
  });

  describe('exists', () => {
    it('ensures connection and delegates to sftp exists (true)', async () => {
      mockSftp.exists.mockResolvedValue(true);
      await expect(connection.exists('/var/www/present.txt')).resolves.toBe(true);
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.exists).toHaveBeenCalledWith('/var/www/present.txt');
    });

    it('passes through false when the path does not exist', async () => {
      mockSftp.exists.mockResolvedValue(false);
      await expect(connection.exists('/var/www/missing.txt')).resolves.toBe(false);
    });

    it('resets the idle timer', async () => {
      mockSftp.exists.mockResolvedValue(false);
      mockSftp.listDirectoryDetailed.mockResolvedValue([]);

      await connection.listDirectory('/var/www');
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      jest.advanceTimersByTime(4 * 60 * 1000);
      await connection.exists('/var/www/anything');
      mockSftp.disconnect.mockClear();

      // 4 minutes after the exists check — timer was reset, still connected
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(mockSftp.disconnect).not.toHaveBeenCalled();

      // 5 minutes after the exists check — idle timeout fires
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });
  });

  describe('statRemoteType', () => {
    it('ensures connection and delegates to sftp statType', async () => {
      mockSftp.statType.mockResolvedValue('d');
      await expect(connection.statRemoteType('/var/www/folder')).resolves.toBe('d');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.statType).toHaveBeenCalledWith('/var/www/folder');
    });

    it('passes through null when the path does not exist', async () => {
      mockSftp.statType.mockResolvedValue(null);
      await expect(connection.statRemoteType('/var/www/missing')).resolves.toBeNull();
    });

    it('resets the idle timer', async () => {
      mockSftp.statType.mockResolvedValue('-');
      mockSftp.listDirectoryDetailed.mockResolvedValue([]);

      await connection.listDirectory('/var/www');
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      jest.advanceTimersByTime(4 * 60 * 1000);
      await connection.statRemoteType('/var/www/file.txt');
      mockSftp.disconnect.mockClear();

      // 4 minutes after the stat — timer was reset, still connected
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(mockSftp.disconnect).not.toHaveBeenCalled();

      // 5 minutes after the stat — idle timeout fires
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('ensures connection and delegates to sftp rename', async () => {
      mockSftp.rename.mockResolvedValue(undefined);
      await connection.rename('/var/www/old.php', '/var/www/new.php');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.rename).toHaveBeenCalledWith('/var/www/old.php', '/var/www/new.php');
    });

    it('propagates the underlying error', async () => {
      mockSftp.rename.mockRejectedValue(new Error('Permission denied'));
      await expect(connection.rename('/var/www/old.php', '/var/www/new.php')).rejects.toThrow('Permission denied');
    });

    it('resets the idle timer', async () => {
      mockSftp.rename.mockResolvedValue(undefined);
      mockSftp.listDirectoryDetailed.mockResolvedValue([]);

      await connection.listDirectory('/var/www');
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      jest.advanceTimersByTime(4 * 60 * 1000);
      await connection.rename('/var/www/old.php', '/var/www/new.php');
      mockSftp.disconnect.mockClear();

      // 4 minutes after the rename — timer was reset, still connected
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(mockSftp.disconnect).not.toHaveBeenCalled();

      // 5 minutes after the rename — idle timeout fires
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });
  });

  describe('chmod', () => {
    it('ensures connection and delegates to sftp chmod', async () => {
      mockSftp.chmod.mockResolvedValue(undefined);
      await connection.chmod('/var/www/index.php', 0o644);
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.chmod).toHaveBeenCalledWith('/var/www/index.php', 0o644);
    });

    it('propagates the underlying error', async () => {
      mockSftp.chmod.mockRejectedValue(new Error('502 Command not implemented'));
      await expect(connection.chmod('/var/www/index.php', 0o644)).rejects.toThrow('502 Command not implemented');
    });

    it('resets the idle timer', async () => {
      mockSftp.chmod.mockResolvedValue(undefined);
      mockSftp.listDirectoryDetailed.mockResolvedValue([]);

      await connection.listDirectory('/var/www');
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      jest.advanceTimersByTime(4 * 60 * 1000);
      await connection.chmod('/var/www/index.php', 0o644);
      mockSftp.disconnect.mockClear();

      // 4 minutes after the chmod — timer was reset, still connected
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(mockSftp.disconnect).not.toHaveBeenCalled();

      // 5 minutes after the chmod — idle timeout fires
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(mockSftp.disconnect).toHaveBeenCalled();
    });
  });

  describe('deleteRemoteFile', () => {
    it('ensures connection and delegates to sftp deleteFile', async () => {
      mockSftp.deleteFile.mockResolvedValue(undefined);
      await connection.deleteRemoteFile('/var/www/old.php');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.deleteFile).toHaveBeenCalledWith('/var/www/old.php');
    });
  });

  describe('deleteRemoteDirectory', () => {
    it('ensures connection and delegates to sftp deleteDirectory', async () => {
      mockSftp.deleteDirectory.mockResolvedValue(undefined);
      await connection.deleteRemoteDirectory('/var/www/old-folder');
      expect(mockSftp.connect).toHaveBeenCalled();
      expect(mockSftp.deleteDirectory).toHaveBeenCalledWith('/var/www/old-folder');
    });
  });

  describe('resolveSymlinkTargets', () => {
    it('calls statType for each symlink entry and returns target type', async () => {
      const entries = [
        { name: 'logs', type: 'd', size: 4096, modifyTime: 1710000000000 },
        { name: 'current', type: 'l', size: 11, modifyTime: 1710000000000 },
        { name: 'index.php', type: '-', size: 1024, modifyTime: 1710000000000 },
        { name: 'config', type: 'l', size: 11, modifyTime: 1710000000000 },
      ];
      mockSftp.statType = jest.fn()
        .mockResolvedValueOnce('d')   // current -> directory
        .mockResolvedValueOnce('-');  // config -> file

      const result = await connection.resolveSymlinkTargets(entries as any, '/var/www');
      expect(mockSftp.statType).toHaveBeenCalledTimes(2);
      expect(mockSftp.statType).toHaveBeenCalledWith('/var/www/current');
      expect(mockSftp.statType).toHaveBeenCalledWith('/var/www/config');
      expect(result.get('current')).toBe('d');
      expect(result.get('config')).toBe('-');
      expect(result.has('logs')).toBe(false);
      expect(result.has('index.php')).toBe(false);
    });

    it('returns null for broken/circular symlinks', async () => {
      const entries = [
        { name: 'broken', type: 'l', size: 11, modifyTime: 1710000000000 },
      ];
      mockSftp.statType = jest.fn().mockResolvedValue(null);

      const result = await connection.resolveSymlinkTargets(entries as any, '/var/www');
      expect(result.get('broken')).toBeNull();
    });

    it('returns empty map when no symlinks exist', async () => {
      const entries = [
        { name: 'logs', type: 'd', size: 4096, modifyTime: 1710000000000 },
        { name: 'index.php', type: '-', size: 1024, modifyTime: 1710000000000 },
      ];
      mockSftp.statType = jest.fn();

      const result = await connection.resolveSymlinkTargets(entries as any, '/var/www');
      expect(mockSftp.statType).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });
  });

  describe('getRootPath', () => {
    it('returns the server rootPath after connecting', async () => {
      await connection.ensureConnected();
      expect(connection.getRootPath()).toBe('/var/www');
    });

    it('returns / before connecting', () => {
      expect(connection.getRootPath()).toBe('/');
    });

    it('uses server rootPath directly (no override concept)', async () => {
      const serverWithDifferentRoot = { ...fakeServer, rootPath: '/home/deploy/myapp' };
      mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: serverWithDifferentRoot });

      await connection.ensureConnected();
      expect(connection.getRootPath()).toBe('/home/deploy/myapp');
    });
  });

  describe('protocol-aware connection', () => {
    it('creates transfer service matching the server type for FTP', async () => {
      const ftpServer = { ...fakeServer, id: 'server-ftp', type: 'ftp' as const };
      const ftpConfig = { defaultServerId: 'server-ftp', servers: { 'FTP Server': ftpServer } };
      mockConfigManager.getConfig.mockResolvedValue(ftpConfig);
      mockConfigManager.getServerById.mockResolvedValue({ name: 'FTP Server', server: ftpServer });
      (createTransferService as jest.Mock).mockClear();
      await connection.ensureConnected();
      expect(createTransferService).toHaveBeenCalledWith('ftp');
    });

    it('creates transfer service matching the server type for FTPS', async () => {
      const ftpsServer = { ...fakeServer, id: 'server-ftps', type: 'ftps' as const };
      const ftpsConfig = { defaultServerId: 'server-ftps', servers: { 'FTPS Server': ftpsServer } };
      mockConfigManager.getConfig.mockResolvedValue(ftpsConfig);
      mockConfigManager.getServerById.mockResolvedValue({ name: 'FTPS Server', server: ftpsServer });
      (createTransferService as jest.Mock).mockClear();
      await connection.ensureConnected();
      expect(createTransferService).toHaveBeenCalledWith('ftps');
    });
  });

  describe('FTP skips host key verification', () => {
    it('does not pass hostVerifier for FTP connections', async () => {
      const ftpServer = { ...fakeServer, id: 'server-ftp', type: 'ftp' as const };
      const ftpConfig = { defaultServerId: 'server-ftp', servers: { 'FTP Server': ftpServer } };
      mockConfigManager.getConfig.mockResolvedValue(ftpConfig);
      mockConfigManager.getServerById.mockResolvedValue({ name: 'FTP Server', server: ftpServer });
      await connection.ensureConnected();
      const connectCall = mockSftp.connect.mock.calls[mockSftp.connect.mock.calls.length - 1];
      const options = connectCall[2];
      expect(options?.hostVerifier).toBeUndefined();
    });

    it('does not pass hostVerifier for FTPS connections', async () => {
      const ftpsServer = { ...fakeServer, id: 'server-ftps', type: 'ftps' as const };
      const ftpsConfig = { defaultServerId: 'server-ftps', servers: { 'FTPS Server': ftpsServer } };
      mockConfigManager.getConfig.mockResolvedValue(ftpsConfig);
      mockConfigManager.getServerById.mockResolvedValue({ name: 'FTPS Server', server: ftpsServer });
      await connection.ensureConnected();
      const connectCall = mockSftp.connect.mock.calls[mockSftp.connect.mock.calls.length - 1];
      const options = connectCall[2];
      expect(options?.hostVerifier).toBeUndefined();
    });
  });

  describe('host key verification', () => {
    it('passes no explicit hostVerifier — SftpService applies the registry HostKeyProvider (timer-aware) itself', async () => {
      await connection.ensureConnected();
      const options = mockSftp.connect.mock.calls[0][2];
      expect(options?.hostVerifier).toBeUndefined();
    });
  });

  describe('config-save invalidation', () => {
    it('updates rootPath in place when only rootPath changed (no disconnect)', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      expect(connection.getRootPath()).toBe('/var/www');
      mockSftp.disconnect.mockClear();

      const updated = { ...fakeServer, rootPath: '/www' };
      mockConfigManager.getConfig.mockResolvedValue({ defaultServerId: 'server-1', servers: { Production: updated } });
      mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: updated });

      await fireOnDidSaveConfig();

      expect(mockSftp.disconnect).not.toHaveBeenCalled();
      expect(connection.getRootPath()).toBe('/www');
    });

    it('disconnects when default server id changes', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      const otherServer = { ...fakeServer, id: 'server-2' };
      mockConfigManager.getConfig.mockResolvedValue({ defaultServerId: 'server-2', servers: { Other: otherServer } });
      mockConfigManager.getServerById.mockResolvedValue({ name: 'Other', server: otherServer });

      await fireOnDidSaveConfig();

      expect(mockSftp.disconnect).toHaveBeenCalled();
    });

    it('disconnects when credentialId on the active server changes', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      const swapped = { ...fakeServer, credentialId: 'cred-2' };
      mockConfigManager.getConfig.mockResolvedValue({ defaultServerId: 'server-1', servers: { Production: swapped } });
      mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: swapped });

      await fireOnDidSaveConfig();

      expect(mockSftp.disconnect).toHaveBeenCalled();
    });

    it('disconnects when the active server is removed from config', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      mockConfigManager.getConfig.mockResolvedValue({ defaultServerId: '', servers: {} });
      mockConfigManager.getServerById.mockResolvedValue(undefined);

      await fireOnDidSaveConfig();

      expect(mockSftp.disconnect).toHaveBeenCalled();
    });

    it('is a no-op when not currently connected', async () => {
      mockSftp.connected = false;
      mockSftp.disconnect.mockClear();

      const updated = { ...fakeServer, rootPath: '/www' };
      mockConfigManager.getConfig.mockResolvedValue({ defaultServerId: 'server-1', servers: { Production: updated } });
      mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: updated });

      await fireOnDidSaveConfig();

      expect(mockSftp.disconnect).not.toHaveBeenCalled();
      expect(mockSftp.connect).not.toHaveBeenCalled();
    });
  });

  // 18a-2b, H3: fixes the pre-existing staleness where an open Remote Files
  // session survived editing (or deleting) its own credential — the session
  // was authenticated with the OLD host/user/auth.
  describe('credential-change invalidation', () => {
    it('drops the open session when its own credential is saved', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      await fireCredentialChange({ id: 'cred-1', kind: 'save' });

      expect(mockSftp.disconnect).toHaveBeenCalled();
      expect(connection.getCurrentServerId()).toBeNull();
    });

    it('drops the open session when its own credential is deleted', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      await fireCredentialChange({ id: 'cred-1', kind: 'delete' });

      expect(mockSftp.disconnect).toHaveBeenCalled();
    });

    it('ignores changes to a credential the session does not use', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      await fireCredentialChange({ id: 'cred-other', kind: 'save' });

      expect(mockSftp.disconnect).not.toHaveBeenCalled();
    });

    it('dispose() unsubscribes from credential changes', async () => {
      await connection.ensureConnected();
      mockSftp.connected = true;
      mockSftp.disconnect.mockClear();

      connection.dispose();
      await fireCredentialChange({ id: 'cred-1', kind: 'save' });

      expect(mockSftp.disconnect).not.toHaveBeenCalled();
    });
  });

  // 18a-2b §I wedge fix: the panel's single shared connection was not guarded
  // against overlapping ensureConnected calls, and a connect parked on an
  // open prompt (chain+MFA) was never cancelled on a default-server change —
  // its getChildren promise never settled and every later render hung until
  // Reload Window. These tests encode the (code-trace-confirmed) repro.
  describe('in-flight connect management (18a-2b §I wedge fix)', () => {
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) { await Promise.resolve(); }
    };

    // Parks every connect until its signal aborts (rejecting like
    // SftpService's abort machinery) or the test resolves it.
    let connectResolvers: Array<() => void>;
    const parkConnects = (): void => {
      connectResolvers = [];
      mockSftp.connect.mockImplementation((_server: unknown, _credentials: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          connectResolvers.push(resolve);
          options?.signal?.addEventListener('abort', () =>
            reject(new Error('Connection cancelled: the connection request was superseded')));
        })
      );
    };

    const switchDefaultTo = (server: typeof fakeServer, name: string) => {
      mockConfigManager.getConfig.mockResolvedValue({ defaultServerId: server.id, servers: { [name]: server } });
      mockConfigManager.getServerById.mockResolvedValue({ name, server });
    };

    it('REPRO: a connect parked on an open prompt settles when the default server changes — the panel cannot wedge', async () => {
      parkConnects();
      const pending = connection.ensureConnected();
      await flushMicrotasks();
      expect(mockSftp.connect).toHaveBeenCalledTimes(1);

      switchDefaultTo({ ...fakeServer, id: 'server-2' }, 'Other');
      await fireOnDidSaveConfig();

      await expect(pending).rejects.toThrow(/cancelled/i);
    });

    it('overlapping ensureConnected calls for the same server share one connect', async () => {
      parkConnects();
      const first = connection.ensureConnected();
      await flushMicrotasks();
      const second = connection.ensureConnected();
      await flushMicrotasks();

      expect(mockSftp.connect).toHaveBeenCalledTimes(1);
      connectResolvers[0]();
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
    });

    it('ensureConnected for a different server aborts the in-flight connect and dials the new one', async () => {
      parkConnects();
      const first = connection.ensureConnected();
      await flushMicrotasks();

      switchDefaultTo({ ...fakeServer, id: 'server-2' }, 'Other');
      const second = connection.ensureConnected();
      await flushMicrotasks();

      await expect(first).rejects.toThrow(/cancelled/i);
      expect(mockSftp.connect).toHaveBeenCalledTimes(2);
      connectResolvers[1]();
      await expect(second).resolves.toBeUndefined();
    });

    it('disconnect() aborts an in-flight connect', async () => {
      parkConnects();
      const pending = connection.ensureConnected();
      await flushMicrotasks();

      await connection.disconnect();

      await expect(pending).rejects.toThrow(/cancelled/i);
    });

    it('a credential change aborts an in-flight connect using that credential', async () => {
      parkConnects();
      const pending = connection.ensureConnected();
      await flushMicrotasks();

      await fireCredentialChange({ id: 'cred-1', kind: 'save' });

      await expect(pending).rejects.toThrow(/cancelled/i);
    });

    it('passes an AbortSignal to the transfer service connect', async () => {
      await connection.ensureConnected();
      const options = mockSftp.connect.mock.calls[0][2];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // 18a-2b, Q34: when a hop on the CURRENT session's route is evicted from
  // the pool (unexpected close, credential change), the session is dead —
  // onDidLoseRoute lets the panel drop to its Disconnected state.
  describe('jump-host route eviction (Q34)', () => {
    const bastionCredential = {
      id: 'cred-bastion', name: 'Bastion', host: 'Bastion.example.com', port: 2222,
      username: 'jump', authMethod: 'password' as const,
    };
    const evictListeners: Array<(key: string) => void> = [];
    const fireEvict = (key: string) => { for (const listener of [...evictListeners]) { listener(key); } };
    const fakePool = {
      onDidEvict: (listener: (key: string) => void) => {
        evictListeners.push(listener);
        return { dispose: () => { const i = evictListeners.indexOf(listener); if (i >= 0) { evictListeners.splice(i, 1); } } };
      },
    };

    let routedConnection: RemoteBrowserConnection;
    let lostRoutes: string[];

    beforeEach(() => {
      evictListeners.length = 0;
      lostRoutes = [];
      mockCredentialManager.getWithSecret.mockResolvedValue({
        ...fakeCredential,
        jumpHosts: ['cred-bastion'],
      });
      mockCredentialManager.getAll.mockResolvedValue([fakeCredential, bastionCredential]);
      // 18b: the route comes from the service (what was actually dialed),
      // not recomputed from the credential list.
      mockSftp.routeKeys = ['jump@bastion.example.com:2222'];
      routedConnection = new RemoteBrowserConnection(
        mockCredentialManager as any,
        mockConfigManager as any,
        mockOutput as any,
        fakePool as any
      );
      routedConnection.onDidLoseRoute((key: string) => lostRoutes.push(key));
    });

    afterEach(() => {
      routedConnection.dispose();
    });

    it('fires onDidLoseRoute when a hop on the current route is evicted (pool key is canonical)', async () => {
      await routedConnection.ensureConnected();
      fireEvict('jump@bastion.example.com:2222');
      expect(lostRoutes).toEqual(['jump@bastion.example.com:2222']);
    });

    it('ignores evictions of hops not on the current route', async () => {
      await routedConnection.ensureConnected();
      fireEvict('other@elsewhere.example.com:22');
      expect(lostRoutes).toEqual([]);
    });

    it('ignores evictions after the session disconnected', async () => {
      await routedConnection.ensureConnected();
      mockSftp.connected = true;
      await routedConnection.disconnect();
      fireEvict('jump@bastion.example.com:2222');
      expect(lostRoutes).toEqual([]);
    });

    it('a session without jump hosts never reacts to evictions', async () => {
      mockCredentialManager.getWithSecret.mockResolvedValue(fakeCredential);
      mockSftp.routeKeys = [];
      await routedConnection.ensureConnected();
      fireEvict('jump@bastion.example.com:2222');
      expect(lostRoutes).toEqual([]);
    });
  });

  it('connects with the server type on the payload — an FTPS server dials as FTPS (feature 35 pre-work)', async () => {
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: { ...fakeServer, type: 'ftps' as const } });

    await connection.ensureConnected();

    expect(mockSftp.connect.mock.calls[0][0]).toEqual(
      expect.objectContaining({ type: 'ftps', host: 'example.com', username: 'deploy' })
    );
  });
});
