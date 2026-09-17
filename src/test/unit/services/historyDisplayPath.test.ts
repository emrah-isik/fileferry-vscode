import { historyDisplayPath } from '../../../services/historyDisplayPath';
import type { UploadHistoryEntry } from '../../../models/UploadHistoryEntry';

// #31: rows created from the Remote Files panel record a temporary local copy
// as their localPath, so the File column showed names like
// "/tmp/fileferry-browse/web.remote.601cdd9c.php" instead of the deployed file.

function entry(overrides: Partial<UploadHistoryEntry>): UploadHistoryEntry {
  return {
    id: 'e',
    timestamp: 1,
    serverId: 's',
    serverName: 'staging',
    localPath: '/workspace/routes/web.php',
    remotePath: '/var/www/staging/routes/web.php',
    action: 'upload',
    result: 'success',
    trigger: 'manual',
    ...overrides,
  };
}

describe('historyDisplayPath', () => {
  it.each(['remote-edit', 'remote-create', 'remote-duplicate'] as const)(
    'shows the remote path for %s rows, whose local path is a temporary copy',
    (trigger) => {
      const shown = historyDisplayPath(entry({ trigger, localPath: '/tmp/fileferry-browse/web.remote.601cdd9c.php' }));
      expect(shown).toBe('/var/www/staging/routes/web.php');
    }
  );

  it.each(['manual', 'multi-server', 'save', 'watch', 'sync', 'remote-upload'] as const)(
    'shows the local path for %s rows',
    (trigger) => {
      expect(historyDisplayPath(entry({ trigger }))).toBe('/workspace/routes/web.php');
    }
  );

  it('falls back to the remote path when a row has no local path', () => {
    expect(historyDisplayPath(entry({ trigger: 'manual', localPath: '' }))).toBe('/var/www/staging/routes/web.php');
  });
});
