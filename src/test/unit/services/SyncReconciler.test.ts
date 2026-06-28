import { reconcile } from '../../../services/SyncReconciler';
import type { LocalFileEntry, RemoteFileEntry } from '../../../services/SyncReconciler';

const APRIL_1 = new Date('2026-04-01T12:00:00Z').getTime();
const APRIL_5 = new Date('2026-04-05T12:00:00Z').getTime();

function local(name: string, modifyTimeMs: number): LocalFileEntry {
  return {
    localPath: `/workspace/public/${name}`,
    remotePath: `/var/www/${name}`,
    modifyTimeMs,
  };
}

function remote(name: string, modifyTimeMs: number): RemoteFileEntry {
  return { remotePath: `/var/www/${name}`, modifyTimeMs };
}

describe('SyncReconciler.reconcile', () => {
  it('marks a local-only file (missing on remote) for upload', () => {
    const plan = reconcile([local('a.php', APRIL_1)], []);

    expect(plan.toUpload.map(item => item.remotePath)).toEqual(['/var/www/a.php']);
    expect(plan.upToDate).toEqual([]);
    expect(plan.remoteExtras).toEqual([]);
  });

  it('uploads a file that is strictly newer locally', () => {
    const plan = reconcile([local('a.php', APRIL_5)], [remote('a.php', APRIL_1)]);

    expect(plan.toUpload.map(item => item.remotePath)).toEqual(['/var/www/a.php']);
    expect(plan.upToDate).toEqual([]);
  });

  it('treats same-age and remote-newer files as up to date (update-only)', () => {
    const plan = reconcile(
      [local('same.php', APRIL_1), local('older.php', APRIL_1)],
      [remote('same.php', APRIL_1), remote('older.php', APRIL_5)]
    );

    expect(plan.toUpload).toEqual([]);
    expect(plan.upToDate.map(item => item.remotePath)).toEqual([
      '/var/www/same.php',
      '/var/www/older.php',
    ]);
  });

  it('marks a remote-only file (no local counterpart) as a remote extra', () => {
    const plan = reconcile([local('a.php', APRIL_1)], [
      remote('a.php', APRIL_1),
      remote('stale.php', APRIL_1),
    ]);

    expect(plan.toUpload).toEqual([]);
    expect(plan.upToDate.map(item => item.remotePath)).toEqual(['/var/www/a.php']);
    expect(plan.remoteExtras).toEqual(['/var/www/stale.php']);
  });

  it('does NOT treat an excluded remote file as an extra (safety #6)', () => {
    // The excluded remote file has no eligible local counterpart, but it is
    // deliberately unmanaged — it must never be pruned.
    const plan = reconcile(
      [local('a.php', APRIL_1)],
      [remote('a.php', APRIL_1), remote('cache/keep.tmp', APRIL_1)],
      { isRemotePathExcluded: remotePath => remotePath === '/var/www/cache/keep.tmp' }
    );

    expect(plan.remoteExtras).toEqual([]);
  });

  it('shifts the upload/skip boundary by timeOffsetMs (mirrors 21b)', () => {
    // Remote is 60s ahead of local clock; offset-adjusting brings them level so
    // the file is same-age (up to date), not newer-on-remote.
    const offsetMs = 60_000;
    const plan = reconcile(
      [local('a.php', APRIL_1)],
      [remote('a.php', APRIL_1 + offsetMs)],
      { timeOffsetMs: offsetMs }
    );

    expect(plan.toUpload).toEqual([]);
    expect(plan.upToDate.map(item => item.remotePath)).toEqual(['/var/www/a.php']);
  });

  it('treats every remote file as an extra when local tree is empty', () => {
    const plan = reconcile([], [remote('a.php', APRIL_1), remote('b.php', APRIL_1)]);

    expect(plan.toUpload).toEqual([]);
    expect(plan.upToDate).toEqual([]);
    expect(plan.remoteExtras).toEqual(['/var/www/a.php', '/var/www/b.php']);
  });

  it('uploads everything and prunes nothing when remote tree is empty', () => {
    const plan = reconcile([local('a.php', APRIL_1), local('b.php', APRIL_1)], []);

    expect(plan.toUpload.map(item => item.remotePath)).toEqual([
      '/var/www/a.php',
      '/var/www/b.php',
    ]);
    expect(plan.remoteExtras).toEqual([]);
  });

  it('emits plain ResolvedUploadItem shape (localPath + remotePath only)', () => {
    const plan = reconcile([local('a.php', APRIL_5)], [remote('a.php', APRIL_1)]);

    expect(plan.toUpload[0]).toEqual({
      localPath: '/workspace/public/a.php',
      remotePath: '/var/www/a.php',
    });
  });
});
