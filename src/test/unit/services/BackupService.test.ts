import { BackupService } from '../../../services/BackupService';
import type { ResolvedUploadItem } from '../../../path/PathResolver';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

jest.mock('fs/promises');

const mockSftp = {
  connect: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn(),
  get: jest.fn(),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../../sftpService', () => ({
  SftpService: jest.fn().mockImplementation(() => mockSftp),
}));

const credential = { id: 'c1', host: 'h', port: 22, username: 'u', authMethod: 'password', password: 'p' } as any;

function item(name: string): ResolvedUploadItem {
  return { localPath: `/workspace/${name}`, remotePath: `/var/www/${name}` };
}

describe('BackupService.backup', () => {
  let service: BackupService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BackupService(mockSftp as any);
    (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
  });

  it('connects SFTP, downloads each existing remote file, and disconnects', async () => {
    const items = [item('index.php')];
    mockSftp.stat.mockResolvedValueOnce({ mtime: new Date() });
    mockSftp.get.mockResolvedValueOnce(Buffer.from('<?php echo 1;'));

    await service.backup(items, credential, 'Production', '/workspace');

    expect(mockSftp.connect).toHaveBeenCalledWith(credential, {
      password: credential.password,
      passphrase: credential.passphrase,
    });
    expect(mockSftp.get).toHaveBeenCalledWith('/var/www/index.php');
    expect(mockSftp.disconnect).toHaveBeenCalled();
  });

  it('skips files that do not exist on remote', async () => {
    const items = [item('new-file.php')];
    mockSftp.stat.mockResolvedValueOnce(null);

    await service.backup(items, credential, 'Production', '/workspace');

    expect(mockSftp.get).not.toHaveBeenCalled();
    expect(mockSftp.disconnect).toHaveBeenCalled();
  });

  it('creates backup directory preserving remote path structure', async () => {
    const items = [item('src/app.php')];
    mockSftp.stat.mockResolvedValueOnce({ mtime: new Date() });
    mockSftp.get.mockResolvedValueOnce(Buffer.from('content'));

    await service.backup(items, credential, 'Production', '/workspace');

    // The mkdir call should contain the remote path structure under .vscode/fileferry-backups
    const mkdirCalls = (fsPromises.mkdir as jest.Mock).mock.calls;
    const backupDir = mkdirCalls.find((call: any[]) =>
      call[0].includes('.vscode/fileferry-backups') && call[0].includes('src')
    );
    expect(backupDir).toBeDefined();
  });

  it('writes downloaded content to backup file', async () => {
    const items = [item('index.php')];
    mockSftp.stat.mockResolvedValueOnce({ mtime: new Date() });
    const content = Buffer.from('<?php echo "hello";');
    mockSftp.get.mockResolvedValueOnce(content);

    await service.backup(items, credential, 'Production', '/workspace');

    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('index.php'),
      content
    );
  });

  it('uses timestamped folder with server name', async () => {
    const items = [item('index.php')];
    mockSftp.stat.mockResolvedValueOnce({ mtime: new Date() });
    mockSftp.get.mockResolvedValueOnce(Buffer.from('data'));

    await service.backup(items, credential, 'Production', '/workspace');

    const writePath = (fsPromises.writeFile as jest.Mock).mock.calls[0][0] as string;
    expect(writePath).toMatch(/\.vscode\/fileferry-backups/);
    expect(writePath).toMatch(/Production/);
    // ISO timestamp pattern: YYYY-MM-DDTHH-MM-SS
    expect(writePath).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  });

  it('handles multiple items in a single backup', async () => {
    const items = [item('a.php'), item('b.php')];
    mockSftp.stat
      .mockResolvedValueOnce({ mtime: new Date() })
      .mockResolvedValueOnce({ mtime: new Date() });
    mockSftp.get
      .mockResolvedValueOnce(Buffer.from('a'))
      .mockResolvedValueOnce(Buffer.from('b'));

    await service.backup(items, credential, 'Production', '/workspace');

    expect(fsPromises.writeFile).toHaveBeenCalledTimes(2);
  });

  it('disconnects even when download throws', async () => {
    const items = [item('index.php')];
    mockSftp.stat.mockResolvedValueOnce({ mtime: new Date() });
    mockSftp.get.mockRejectedValueOnce(new Error('Network error'));

    await expect(service.backup(items, credential, 'Production', '/workspace'))
      .rejects.toThrow('Network error');
    expect(mockSftp.disconnect).toHaveBeenCalled();
  });

  it('does nothing for empty items list', async () => {
    await service.backup([], credential, 'Production', '/workspace');

    expect(mockSftp.connect).not.toHaveBeenCalled();
    expect(mockSftp.get).not.toHaveBeenCalled();
  });
});

describe('BackupService.cleanup', () => {
  let service: BackupService;
  const backupRoot = path.join('/workspace', '.vscode/fileferry-backups');

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BackupService(mockSftp as any);
    (fsPromises.rm as jest.Mock).mockResolvedValue(undefined);
  });

  function setupFolders(folders: string[], dirSizes: Record<string, number> = {}) {
    // readdir: first call returns folder names, subsequent calls for getDirSize return files
    (fsPromises.readdir as jest.Mock).mockImplementation(async (dirPath: string) => {
      if (dirPath === backupRoot) {
        return folders;
      }
      // getDirSize subfolder — return a single file
      const folderName = folders.find(f => dirPath.includes(f));
      if (folderName && dirSizes[folderName] !== undefined) {
        return ['backup-file.dat'];
      }
      return [];
    });

    (fsPromises.stat as jest.Mock).mockImplementation(async (filePath: string) => {
      // Check if this is a top-level folder check (isDirectory)
      const folderName = folders.find(f => filePath === path.join(backupRoot, f));
      if (folderName) {
        return { isDirectory: () => true, size: 0 };
      }
      // getDirSize file stat — return the configured size
      const parentFolder = folders.find(f => filePath.includes(f));
      if (parentFolder && dirSizes[parentFolder] !== undefined) {
        return { isDirectory: () => false, size: dirSizes[parentFolder] };
      }
      return { isDirectory: () => false, size: 0 };
    });
  }

  it('deletes folders older than retentionDays', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-06T12:00:00Z').getTime());

    const oldFolder = '2026-03-27T10-00-00-Production';
    const recentFolder = '2026-04-05T10-00-00-Production';

    setupFolders([oldFolder, recentFolder], {
      [recentFolder]: 10 * 1024 * 1024,
    });

    await service.cleanup('/workspace', 7, 100);

    expect(fsPromises.rm).toHaveBeenCalledWith(
      path.join(backupRoot, oldFolder),
      { recursive: true }
    );
    const rmPaths = (fsPromises.rm as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(rmPaths.some((p: string) => p.includes(recentFolder))).toBe(false);

    jest.restoreAllMocks();
  });

  it('deletes oldest folders when total size exceeds maxSizeMB', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-06T12:00:00Z').getTime());

    const folder1 = '2026-04-04T10-00-00-Production';
    const folder2 = '2026-04-05T10-00-00-Production';

    setupFolders([folder1, folder2], {
      [folder1]: 60 * 1024 * 1024,
      [folder2]: 60 * 1024 * 1024,
    });

    await service.cleanup('/workspace', 7, 100);

    expect(fsPromises.rm).toHaveBeenCalledWith(
      path.join(backupRoot, folder1),
      { recursive: true }
    );

    jest.restoreAllMocks();
  });

  it('does nothing when backup directory does not exist', async () => {
    (fsPromises.readdir as jest.Mock).mockRejectedValue({ code: 'ENOENT' });

    await service.cleanup('/workspace', 7, 100);

    expect(fsPromises.rm).not.toHaveBeenCalled();
  });

  it('skips non-directory entries', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-06T12:00:00Z').getTime());

    const oldFolder = '2026-03-01T10-00-00-Production';

    (fsPromises.readdir as jest.Mock).mockImplementation(async (dirPath: string) => {
      if (dirPath === backupRoot) {
        return ['.gitkeep', oldFolder];
      }
      return [];
    });

    (fsPromises.stat as jest.Mock).mockImplementation(async (filePath: string) => {
      if (filePath.includes('.gitkeep')) {
        return { isDirectory: () => false, size: 0 };
      }
      return { isDirectory: () => true, size: 0 };
    });

    await service.cleanup('/workspace', 7, 100);

    const rmCalls = (fsPromises.rm as jest.Mock).mock.calls;
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0][0]).toContain(oldFolder);

    jest.restoreAllMocks();
  });
});
