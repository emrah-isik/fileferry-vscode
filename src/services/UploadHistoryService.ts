import * as fs from 'fs/promises';
import * as path from 'path';
import type { UploadHistoryEntry, HistoryFilter } from '../models/UploadHistoryEntry';

export class UploadHistoryService {
  private readonly historyPath: string;

  constructor(
    workspaceRoot: string,
    private readonly maxEntries: number
  ) {
    this.historyPath = path.join(workspaceRoot, '.vscode', 'fileferry-history.jsonl');
  }

  async log(entries: UploadHistoryEntry[]): Promise<void> {
    if (entries.length === 0 || this.maxEntries === 0) {
      return;
    }
    await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(this.historyPath, lines, 'utf-8');
  }

  async getAll(): Promise<UploadHistoryEntry[]> {
    let content: string;
    try {
      content = await fs.readFile(this.historyPath, 'utf-8');
    } catch {
      return [];
    }
    return content
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .reduce<UploadHistoryEntry[]>((acc, line) => {
        try {
          acc.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
        return acc;
      }, []);
  }

  async getFiltered(filter: HistoryFilter): Promise<UploadHistoryEntry[]> {
    const all = await this.getAll();
    return all.filter(e => {
      if (filter.serverId && e.serverId !== filter.serverId) { return false; }
      if (filter.result && e.result !== filter.result) { return false; }
      if (filter.search && !e.localPath.toLowerCase().includes(filter.search.toLowerCase())) { return false; }
      return true;
    });
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.historyPath);
    } catch {
      // file may not exist
    }
  }

  async enforceRetention(): Promise<void> {
    const entries = await this.getAll();
    if (entries.length <= this.maxEntries) {
      return;
    }
    const kept = entries.slice(entries.length - this.maxEntries);
    const lines = kept.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(this.historyPath, lines, 'utf-8');
  }
}
