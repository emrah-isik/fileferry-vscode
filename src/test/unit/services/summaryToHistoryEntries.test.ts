jest.mock('crypto', () => ({
  randomUUID: jest.fn().mockReturnValue('mock-uuid'),
}));

import { summaryToHistoryEntries } from '../../../services/summaryToHistoryEntries';
import type { UploadSummaryV2 } from '../../../services/UploadOrchestratorV2';

function emptySummary(): UploadSummaryV2 {
  return { succeeded: [], failed: [], deleted: [], deleteFailed: [] };
}

describe('summaryToHistoryEntries', () => {
  const base = {
    serverId: 'srv-1',
    serverName: 'Production',
    timestamp: 1700000000000,
    trigger: 'manual' as const,
  };

  it('maps succeeded items to upload/success entries', () => {
    const summary: UploadSummaryV2 = {
      ...emptySummary(),
      succeeded: [{ localPath: '/workspace/a.php', remotePath: '/var/www/a.php' }],
    };
    const result = summaryToHistoryEntries(summary, base.serverId, base.serverName, base.timestamp, base.trigger);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'mock-uuid',
      timestamp: 1700000000000,
      serverId: 'srv-1',
      serverName: 'Production',
      localPath: '/workspace/a.php',
      remotePath: '/var/www/a.php',
      action: 'upload',
      result: 'success',
      trigger: 'manual',
    });
    expect(result[0].error).toBeUndefined();
  });

  it('maps failed items to upload/failed entries with error message', () => {
    const summary: UploadSummaryV2 = {
      ...emptySummary(),
      failed: [{ localPath: '/workspace/b.php', error: 'Permission denied' }],
    };
    const result = summaryToHistoryEntries(summary, base.serverId, base.serverName, base.timestamp, base.trigger);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      action: 'upload',
      result: 'failed',
      localPath: '/workspace/b.php',
      error: 'Permission denied',
    });
  });

  it('maps deleted items to delete/success entries', () => {
    const summary: UploadSummaryV2 = {
      ...emptySummary(),
      deleted: ['/var/www/old.php'],
    };
    const result = summaryToHistoryEntries(summary, base.serverId, base.serverName, base.timestamp, base.trigger);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      action: 'delete',
      result: 'success',
      remotePath: '/var/www/old.php',
      localPath: '',
    });
  });

  it('maps deleteFailed items to delete/failed entries', () => {
    const summary: UploadSummaryV2 = {
      ...emptySummary(),
      deleteFailed: [{ remotePath: '/var/www/stuck.php', error: 'No such file' }],
    };
    const result = summaryToHistoryEntries(summary, base.serverId, base.serverName, base.timestamp, base.trigger);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      action: 'delete',
      result: 'failed',
      remotePath: '/var/www/stuck.php',
      error: 'No such file',
    });
  });

  it('maps cancelled items to upload/cancelled entries', () => {
    const summary: UploadSummaryV2 = {
      ...emptySummary(),
      cancelled: [{ localPath: '/workspace/c.php', remotePath: '/var/www/c.php' }],
    };
    const result = summaryToHistoryEntries(summary, base.serverId, base.serverName, base.timestamp, base.trigger);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      action: 'upload',
      result: 'cancelled',
      localPath: '/workspace/c.php',
    });
  });

  it('combines all categories into one flat array', () => {
    const summary: UploadSummaryV2 = {
      succeeded: [{ localPath: '/workspace/a.php', remotePath: '/var/www/a.php' }],
      failed: [{ localPath: '/workspace/b.php', error: 'err' }],
      deleted: ['/var/www/old.php'],
      deleteFailed: [{ remotePath: '/var/www/stuck.php', error: 'err' }],
      cancelled: [{ localPath: '/workspace/c.php', remotePath: '/var/www/c.php' }],
    };
    const result = summaryToHistoryEntries(summary, base.serverId, base.serverName, base.timestamp, base.trigger);
    expect(result).toHaveLength(5);
  });

  it('returns empty array for an empty summary', () => {
    const result = summaryToHistoryEntries(emptySummary(), base.serverId, base.serverName, base.timestamp, base.trigger);
    expect(result).toEqual([]);
  });

  it('uses the provided trigger type', () => {
    const summary: UploadSummaryV2 = {
      ...emptySummary(),
      succeeded: [{ localPath: '/workspace/a.php', remotePath: '/var/www/a.php' }],
    };
    const result = summaryToHistoryEntries(summary, base.serverId, base.serverName, base.timestamp, 'save');
    expect(result[0].trigger).toBe('save');
  });
});
