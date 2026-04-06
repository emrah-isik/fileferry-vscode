import { RemoteBrowserConnection } from '../../../remoteBrowser/RemoteBrowserConnection';
import { SftpService } from '../../../sftpService';
import { HostKeyManager } from '../../../ssh/HostKeyManager';
import * as hostKeyPrompt from '../../../ssh/hostKeyPrompt';

jest.mock('../../../sftpService');
jest.mock('../../../ssh/HostKeyManager');
jest.mock('../../../ssh/hostKeyPrompt');

const mockSftp = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  listDirectoryDetailed: jest.fn(),
  get: jest.fn(),
  deleteFile: jest.fn(),
  deleteDirectory: jest.fn(),
  connected: false,
};

(SftpService as jest.Mock).mockImplementation(() => mockSftp);

const mockCredentialManager = {
  getWithSecret: jest.fn(),
};

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
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
});
