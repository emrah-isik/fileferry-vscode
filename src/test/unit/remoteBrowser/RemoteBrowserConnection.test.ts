import { RemoteBrowserConnection } from '../../../remoteBrowser/RemoteBrowserConnection';
import { HostKeyManager } from '../../../ssh/HostKeyManager';
import * as hostKeyPrompt from '../../../ssh/hostKeyPrompt';

jest.mock('../../../transferServiceFactory');
jest.mock('../../../ssh/HostKeyManager');
jest.mock('../../../ssh/hostKeyPrompt');

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
  statType: jest.fn(),
  mkdir: jest.fn(),
  exists: jest.fn(),
  connected: false,
};

(createTransferService as jest.Mock).mockReturnValue(mockSftp);

const mockCredentialManager = {
  getWithSecret: jest.fn(),
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

const mockHostKeyManager = {
  check: jest.fn(),
  trust: jest.fn(),
  getFingerprint: jest.fn(),
};

(HostKeyManager as jest.Mock).mockImplementation(() => mockHostKeyManager);

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
    mockSftp.connected = false;
    mockConfigManager.getConfig.mockResolvedValue(fakeConfig);
    mockConfigManager.getServerById.mockResolvedValue({ name: 'Production', server: fakeServer });
    mockCredentialManager.getWithSecret.mockResolvedValue(fakeCredential);
    mockSftp.connect.mockResolvedValue(undefined);
    mockSftp.disconnect.mockResolvedValue(undefined);

    mockHostKeyManager.check.mockResolvedValue('trusted');
    mockHostKeyManager.trust.mockResolvedValue(undefined);
    mockHostKeyManager.getFingerprint.mockReturnValue('SHA256:abc123');

    connection = new RemoteBrowserConnection(
      mockCredentialManager as any,
      mockConfigManager as any,
      mockOutput as any,
      '/fake/global-storage'
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
        expect.objectContaining({ hostVerifier: expect.any(Function) })
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
    it('passes a hostVerifier callback to SftpService.connect', async () => {
      await connection.ensureConnected();
      expect(mockSftp.connect).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ hostVerifier: expect.any(Function) })
      );
    });

    it('hostVerifier accepts trusted keys without prompting', async () => {
      mockHostKeyManager.check.mockResolvedValue('trusted');
      mockSftp.connect.mockImplementation(async (_cfg: any, _creds: any, opts: any) => {
        const result = await opts.hostVerifier(Buffer.from('fakekey'));
        expect(result).toBe(true);
      });
      await connection.ensureConnected();
      expect(hostKeyPrompt.showHostKeyPrompt).not.toHaveBeenCalled();
    });

    it('hostVerifier prompts for unknown keys and trusts on accept', async () => {
      mockHostKeyManager.check.mockResolvedValue('unknown');
      (hostKeyPrompt.showHostKeyPrompt as jest.Mock).mockResolvedValue(true);
      mockSftp.connect.mockImplementation(async (_cfg: any, _creds: any, opts: any) => {
        const result = await opts.hostVerifier(Buffer.from('newkey'));
        expect(result).toBe(true);
      });
      await connection.ensureConnected();
      expect(hostKeyPrompt.showHostKeyPrompt).toHaveBeenCalledWith(
        'example.com', 22, expect.any(String), 'unknown'
      );
      expect(mockHostKeyManager.trust).toHaveBeenCalled();
    });

    it('hostVerifier rejects unknown keys when user declines', async () => {
      mockHostKeyManager.check.mockResolvedValue('unknown');
      (hostKeyPrompt.showHostKeyPrompt as jest.Mock).mockResolvedValue(false);
      mockSftp.connect.mockImplementation(async (_cfg: any, _creds: any, opts: any) => {
        const result = await opts.hostVerifier(Buffer.from('newkey'));
        expect(result).toBe(false);
      });
      await connection.ensureConnected();
      expect(mockHostKeyManager.trust).not.toHaveBeenCalled();
    });

    it('hostVerifier prompts with warning for changed keys', async () => {
      mockHostKeyManager.check.mockResolvedValue('changed');
      (hostKeyPrompt.showHostKeyPrompt as jest.Mock).mockResolvedValue(true);
      mockSftp.connect.mockImplementation(async (_cfg: any, _creds: any, opts: any) => {
        const result = await opts.hostVerifier(Buffer.from('changedkey'));
        expect(result).toBe(true);
      });
      await connection.ensureConnected();
      expect(hostKeyPrompt.showHostKeyPrompt).toHaveBeenCalledWith(
        'example.com', 22, expect.any(String), 'changed'
      );
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
});
