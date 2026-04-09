import { randomUUID } from 'crypto';
import type { UploadHistoryEntry } from '../models/UploadHistoryEntry';
import type { UploadSummaryV2 } from './UploadOrchestratorV2';

export function summaryToHistoryEntries(
  summary: UploadSummaryV2,
  serverId: string,
  serverName: string,
  timestamp: number,
  trigger: UploadHistoryEntry['trigger']
): UploadHistoryEntry[] {
  const entries: UploadHistoryEntry[] = [];

  for (const item of summary.succeeded) {
    entries.push({
      id: randomUUID(),
      timestamp,
      serverId,
      serverName,
      localPath: item.localPath,
      remotePath: item.remotePath,
      action: 'upload',
      result: 'success',
      trigger,
    });
  }

  for (const item of summary.failed) {
    entries.push({
      id: randomUUID(),
      timestamp,
      serverId,
      serverName,
      localPath: item.localPath,
      remotePath: '',
      action: 'upload',
      result: 'failed',
      error: item.error,
      trigger,
    });
  }

  for (const remotePath of summary.deleted) {
    entries.push({
      id: randomUUID(),
      timestamp,
      serverId,
      serverName,
      localPath: '',
      remotePath,
      action: 'delete',
      result: 'success',
      trigger,
    });
  }

  for (const item of summary.deleteFailed) {
    entries.push({
      id: randomUUID(),
      timestamp,
      serverId,
      serverName,
      localPath: '',
      remotePath: item.remotePath,
      action: 'delete',
      result: 'failed',
      error: item.error,
      trigger,
    });
  }

  for (const item of summary.cancelled ?? []) {
    entries.push({
      id: randomUUID(),
      timestamp,
      serverId,
      serverName,
      localPath: item.localPath,
      remotePath: item.remotePath,
      action: 'upload',
      result: 'cancelled',
      trigger,
    });
  }

  return entries;
}
