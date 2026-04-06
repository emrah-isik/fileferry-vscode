import { FileDateGuard } from '../../../services/FileDateGuard';
import type { ResolvedUploadItem } from '../../../path/PathResolver';
import * as fs from 'fs';

jest.mock('fs');

const mockSftp = {
  connect: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn(),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../../sftpService', () => ({
  SftpService: jest.fn().mockImplementation(() => mockSftp),
}));

const credential = { id: 'c1', host: 'h', port: 22, username: 'u', authMethod: 'password', password: 'p' } as any;

function item(name: string): ResolvedUploadItem {
  return { localPath: `/workspace/${name}`, remotePath: `/var/www/${name}` };
}

describe('FileDateGuard', () => {
  let guard: FileDateGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new FileDateGuard(mockSftp as any);
  });

  it('returns empty array when all local files are newer', async () => {
    const items = [item('a.php'), item('b.php')];
    // Remote mtime: April 1, Local mtime: April 5
    mockSftp.stat
      .mockResolvedValueOnce({ mtime: new Date('2026-04-01T12:00:00Z') })
      .mockResolvedValueOnce({ mtime: new Date('2026-04-01T12:00:00Z') });
    (fs.statSync as jest.Mock)
      .mockReturnValueOnce({ mtimeMs: new Date('2026-04-05T12:00:00Z').getTime() })
      .mockReturnValueOnce({ mtimeMs: new Date('2026-04-05T12:00:00Z').getTime() });

    const result = await guard.check(items, credential);

    expect(result).toEqual([]);
  });

  it('returns items where remote file is newer than local', async () => {
    const items = [item('a.php'), item('b.php')];
    // a.php: remote newer; b.php: local newer
    mockSftp.stat
      .mockResolvedValueOnce({ mtime: new Date('2026-04-05T12:00:00Z') })
      .mockResolvedValueOnce({ mtime: new Date('2026-04-01T12:00:00Z') });
    (fs.statSync as jest.Mock)
      .mockReturnValueOnce({ mtimeMs: new Date('2026-04-01T12:00:00Z').getTime() })
      .mockReturnValueOnce({ mtimeMs: new Date('2026-04-05T12:00:00Z').getTime() });

    const result = await guard.check(items, credential);

    expect(result).toEqual([item('a.php')]);
  });

  it('skips files that do not exist on remote (new files)', async () => {
    const items = [item('new.php')];
    mockSftp.stat.mockResolvedValueOnce(null);

    const result = await guard.check(items, credential);

    expect(result).toEqual([]);
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  it('connects and disconnects around the check', async () => {
    const items = [item('a.php')];
    mockSftp.stat.mockResolvedValueOnce(null);

    await guard.check(items, credential);

    expect(mockSftp.connect).toHaveBeenCalledWith(
      credential,
      { password: credential.password, passphrase: credential.passphrase }
    );
    expect(mockSftp.disconnect).toHaveBeenCalled();
  });

  it('disconnects even when stat throws', async () => {
    const items = [item('a.php')];
    mockSftp.stat.mockRejectedValueOnce(new Error('Network error'));

    await expect(guard.check(items, credential)).rejects.toThrow('Network error');
    expect(mockSftp.disconnect).toHaveBeenCalled();
  });

  it('returns empty array for empty items list', async () => {
    const result = await guard.check([], credential);

    expect(result).toEqual([]);
    expect(mockSftp.stat).not.toHaveBeenCalled();
  });

  it('treats equal timestamps as safe (no warning)', async () => {
    const items = [item('a.php')];
    const sameTime = new Date('2026-04-03T12:00:00Z');
    mockSftp.stat.mockResolvedValueOnce({ mtime: sameTime });
    (fs.statSync as jest.Mock).mockReturnValueOnce({ mtimeMs: sameTime.getTime() });

    const result = await guard.check(items, credential);

    expect(result).toEqual([]);
  });
});
