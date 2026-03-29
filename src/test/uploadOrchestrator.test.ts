import { UploadOrchestrator } from '../uploadOrchestrator';
import { GitFile } from '../types';

// All dependencies are injected as mocks — no real SFTP connection, no disk access
const mockSftpService = {
  connect: jest.fn(),
  uploadFiles: jest.fn(),
  disconnect: jest.fn(),
};

const mockConfigManager = {
  loadConfig: jest.fn(),
  resolveRemotePath: jest.fn(),
};

const mockSecretManager = {
  getPassword: jest.fn(),
  getPassphrase: jest.fn(),
};

const prodServer = {
  id: 'prod',
  name: 'Production',
  mappings: [{ localPath: '/', remotePath: '/var/www' }],
  excludedPaths: [],
  authMethod: 'password'
};

const singleFile: GitFile = {
  absolutePath: '/proj/src/app.php',
  relativePath: 'src/app.php',
  workspaceRoot: '/proj',
  status: 'modified',
  checked: true
};

describe('UploadOrchestrator', () => {
  let orchestrator: UploadOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new UploadOrchestrator(
      mockSftpService as any,
      mockConfigManager as any,
      mockSecretManager as any
    );
    mockConfigManager.loadConfig.mockResolvedValue({
      defaultServer: 'prod',
      servers: [prodServer]
    });
    mockSecretManager.getPassword.mockResolvedValue('secret');
    mockSftpService.connect.mockResolvedValue(undefined);
    mockSftpService.disconnect.mockResolvedValue(undefined);
    mockSftpService.uploadFiles.mockResolvedValue({ succeeded: [], failed: [] });
  });

  it('resolves paths and calls uploadFiles with correct pairs', async () => {
    mockConfigManager.resolveRemotePath.mockReturnValue('/var/www/src/app.php');
    await orchestrator.upload([singleFile], 'prod', jest.fn());
    expect(mockSftpService.uploadFiles).toHaveBeenCalledWith(
      [{ localPath: '/proj/src/app.php', remotePath: '/var/www/src/app.php' }],
      expect.any(Function)
    );
  });

  it('skips files where resolveRemotePath returns null', async () => {
    mockConfigManager.resolveRemotePath.mockReturnValue(null);
    const result = await orchestrator.upload([singleFile], 'prod', jest.fn());
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toBe('/proj/src/app.php');
    expect(mockSftpService.uploadFiles).toHaveBeenCalledWith([], expect.any(Function));
  });

  it('always disconnects even when upload throws', async () => {
    mockConfigManager.resolveRemotePath.mockReturnValue('/var/www/src/app.php');
    mockSftpService.uploadFiles.mockRejectedValue(new Error('Network error'));
    await expect(orchestrator.upload([singleFile], 'prod', jest.fn())).rejects.toThrow('Network error');
    expect(mockSftpService.disconnect).toHaveBeenCalled();
  });

  it('always disconnects on success', async () => {
    mockConfigManager.resolveRemotePath.mockReturnValue('/var/www/src/app.php');
    mockSftpService.uploadFiles.mockResolvedValue({ succeeded: ['/var/www/src/app.php'], failed: [] });
    await orchestrator.upload([singleFile], 'prod', jest.fn());
    expect(mockSftpService.disconnect).toHaveBeenCalled();
  });

  it('throws when server id is not found in config', async () => {
    mockConfigManager.loadConfig.mockResolvedValue({ servers: [] });
    await expect(orchestrator.upload([singleFile], 'ghost', jest.fn()))
      .rejects.toThrow('Server "ghost" not found');
  });

  it('uses password auth when authMethod is password', async () => {
    mockConfigManager.resolveRemotePath.mockReturnValue('/var/www/src/app.php');
    await orchestrator.upload([singleFile], 'prod', jest.fn());
    expect(mockSftpService.connect).toHaveBeenCalledWith(
      prodServer,
      expect.objectContaining({ password: 'secret' })
    );
  });
});
