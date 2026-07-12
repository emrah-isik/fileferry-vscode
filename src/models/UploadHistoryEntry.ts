export interface UploadHistoryEntry {
  id: string;
  timestamp: number;
  serverId: string;
  serverName: string;
  localPath: string;
  remotePath: string;
  action: 'upload' | 'delete';
  result: 'success' | 'failed' | 'cancelled';
  error?: string;
  trigger: 'manual' | 'multi-server' | 'save' | 'watch' | 'sync' | 'remote-edit';
}

export interface HistoryFilter {
  serverId?: string;
  result?: UploadHistoryEntry['result'];
  search?: string;
  trigger?: UploadHistoryEntry['trigger'];
}
