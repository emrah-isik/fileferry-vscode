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

  describe('timeOffsetMs', () => {
    it('positive offset suppresses false positive from fast remote clock', async () => {
      const items = [item('a.php')];
      // Remote clock is 5 min ahead: remote shows 12:05, local is 12:01
      // Without offset: 12:05 > 12:01 → false positive
      // With +300000ms offset: adjusted = 12:05 - 5min = 12:00 < 12:01 → no warning
      const remoteTime = new Date('2026-04-03T12:05:00Z');
      const localTime = new Date('2026-04-03T12:01:00Z');
      mockSftp.stat.mockResolvedValueOnce({ mtime: remoteTime });
      (fs.statSync as jest.Mock).mockReturnValueOnce({ mtimeMs: localTime.getTime() });

      const result = await guard.check(items, credential, 300_000);

      expect(result).toEqual([]);
    });

    it('negative offset correctly flags remote as newer when remote clock is slow', async () => {
      const items = [item('a.php')];
      // Remote clock is 5 min behind: remote shows 11:55 but it's actually 12:00 local
      // Remote file mtime 11:56 → actual time was 12:01 local, which is after local 12:00
      // timeOffsetMs = -300000 (remote is 5 min behind)
      // adjusted = 11:56 - (-5min) = 12:01 > 12:00 → warning (correctly detected as newer)
      const remoteTime = new Date('2026-04-03T11:56:00Z');
      const localTime = new Date('2026-04-03T12:00:00Z');
      mockSftp.stat.mockResolvedValueOnce({ mtime: remoteTime });
      (fs.statSync as jest.Mock).mockReturnValueOnce({ mtimeMs: localTime.getTime() });

      const result = await guard.check(items, credential, -300_000);

      expect(result).toEqual([item('a.php')]);
    });

    it('timeOffsetMs=0 behaves same as no offset', async () => {
      const items = [item('a.php')];
      mockSftp.stat.mockResolvedValueOnce({ mtime: new Date('2026-04-05T12:00:00Z') });
      (fs.statSync as jest.Mock).mockReturnValueOnce({ mtimeMs: new Date('2026-04-01T12:00:00Z').getTime() });

      const result = await guard.check(items, credential, 0);

      expect(result).toEqual([item('a.php')]);
    });
  });
});
