import { DiffService } from '../diffService';
import { ServerConfig } from '../types';

// All dependencies injected — no real SFTP, no real disk writes
const mockSftpService = {
  connect: jest.fn(),
  get: jest.fn(),
  disconnect: jest.fn(),
};

// Mock fs/promises so we don't actually write to disk
jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rm: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';

const server: ServerConfig = {
  id: 'prod', name: 'Production', type: 'sftp',
  host: 'x.com', port: 22, username: 'u',
  authMethod: 'password', mappings: [], excludedPaths: []
};

describe('DiffService', () => {
  let service: DiffService;
  const tempDir = '/tmp/fileferry-test';

  beforeEach(() => {
    jest.clearAllMocks();
    mockSftpService.connect.mockResolvedValue(undefined);
    mockSftpService.disconnect.mockResolvedValue(undefined);
    mockSftpService.get.mockResolvedValue(Buffer.from('<?php echo "remote"; ?>'));
    service = new DiffService(mockSftpService as any, tempDir);
  });

  describe('downloadRemoteFile', () => {
    it('connects, downloads and disconnects', async () => {
      await service.downloadRemoteFile(server, { password: 'secret' }, '/var/www/index.php');
      expect(mockSftpService.connect).toHaveBeenCalledWith(server, { password: 'secret' });
      expect(mockSftpService.get).toHaveBeenCalledWith('/var/www/index.php');
      expect(mockSftpService.disconnect).toHaveBeenCalled();
    });

    it('returns a temp path containing the base filename', async () => {
      const result = await service.downloadRemoteFile(server, {}, '/var/www/index.php');
      // Temp file is named like: index.remote.<hash>.php
      expect(result).toContain('index');
      expect(result).toContain('.php');
    });

    it('returns a temp path inside the configured temp directory', async () => {
      const result = await service.downloadRemoteFile(server, {}, '/var/www/index.php');
      expect(result).toContain(tempDir);
    });

    it('returns the same path for the same remote file (stable/deterministic)', async () => {
      const path1 = await service.downloadRemoteFile(server, {}, '/var/www/a.php');
      const path2 = await service.downloadRemoteFile(server, {}, '/var/www/a.php');
      expect(path1).toBe(path2);
    });

    it('returns different paths for different remote files', async () => {
      const path1 = await service.downloadRemoteFile(server, {}, '/var/www/a.php');
      const path2 = await service.downloadRemoteFile(server, {}, '/var/www/b.php');
      expect(path1).not.toBe(path2);
    });

    it('writes the downloaded content to the temp file', async () => {
      const content = Buffer.from('<?php echo "hello"; ?>');
      mockSftpService.get.mockResolvedValue(content);
      const tempPath = await service.downloadRemoteFile(server, {}, '/var/www/index.php');
      expect(fs.writeFile).toHaveBeenCalledWith(tempPath, content);
    });

    it('always disconnects even if download fails', async () => {
      mockSftpService.get.mockRejectedValue(new Error('No such file'));
      await expect(
        service.downloadRemoteFile(server, {}, '/var/www/missing.php')
      ).rejects.toThrow('No such file');
      expect(mockSftpService.disconnect).toHaveBeenCalled();
    });

    it('creates temp directory recursively', async () => {
      await service.downloadRemoteFile(server, {}, '/var/www/index.php');
      expect(fs.mkdir).toHaveBeenCalledWith(tempDir, { recursive: true });
    });
  });

  describe('cleanup', () => {
    it('removes temp directory', async () => {
      await service.cleanup();
      expect(fs.rm).toHaveBeenCalledWith(tempDir, { recursive: true, force: true });
    });
  });
});
