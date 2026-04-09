import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { UploadHistoryService } from '../../../services/UploadHistoryService';
import type { UploadHistoryEntry } from '../../../models/UploadHistoryEntry';

function entry(overrides: Partial<UploadHistoryEntry> = {}): UploadHistoryEntry {
  return {
    id: 'e-1',
    timestamp: 1700000000000,
    serverId: 'srv-1',
    serverName: 'Production',
    localPath: '/workspace/src/app.php',
    remotePath: '/var/www/src/app.php',
    action: 'upload',
    result: 'success',
    trigger: 'manual',
    ...overrides,
  };
}

describe('UploadHistoryService', () => {
  let tmpDir: string;
  let historyPath: string;
  let service: UploadHistoryService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fileferry-history-'));
    historyPath = path.join(tmpDir, '.vscode', 'fileferry-history.jsonl');
    service = new UploadHistoryService(tmpDir, 10000);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('log()', () => {
    it('creates the .vscode directory and JSONL file if they do not exist', async () => {
      await service.log([entry()]);

      const content = await fs.readFile(historyPath, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.id).toBe('e-1');
    });

    it('appends multiple entries as separate lines', async () => {
      await service.log([entry({ id: 'e-1' }), entry({ id: 'e-2' })]);

      const lines = (await fs.readFile(historyPath, 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).id).toBe('e-1');
      expect(JSON.parse(lines[1]).id).toBe('e-2');
    });

    it('appends to an existing file without overwriting', async () => {
      await service.log([entry({ id: 'e-1' })]);
      await service.log([entry({ id: 'e-2' })]);

      const lines = (await fs.readFile(historyPath, 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(2);
    });

    it('does nothing when entries array is empty', async () => {
      await service.log([]);

      await expect(fs.access(historyPath)).rejects.toThrow();
    });

    it('does nothing when maxEntries is 0 (logging disabled)', async () => {
      const disabled = new UploadHistoryService(tmpDir, 0);
      await disabled.log([entry()]);

      await expect(fs.access(historyPath)).rejects.toThrow();
    });
  });

  describe('getAll()', () => {
    it('returns empty array when history file does not exist', async () => {
      const result = await service.getAll();
      expect(result).toEqual([]);
    });

    it('returns all entries in order', async () => {
      await service.log([entry({ id: 'e-1' }), entry({ id: 'e-2' })]);

      const result = await service.getAll();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('e-1');
      expect(result[1].id).toBe('e-2');
    });

    it('skips malformed JSON lines gracefully', async () => {
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.writeFile(historyPath, JSON.stringify(entry({ id: 'e-1' })) + '\nINVALID\n' + JSON.stringify(entry({ id: 'e-3' })) + '\n');

      const result = await service.getAll();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('e-1');
      expect(result[1].id).toBe('e-3');
    });
  });

  describe('getFiltered()', () => {
    beforeEach(async () => {
      await service.log([
        entry({ id: 'e-1', serverId: 'srv-1', result: 'success', localPath: '/workspace/src/app.php' }),
        entry({ id: 'e-2', serverId: 'srv-2', result: 'failed', error: 'Timeout', localPath: '/workspace/src/util.ts' }),
        entry({ id: 'e-3', serverId: 'srv-1', result: 'cancelled', localPath: '/workspace/lib/helper.php' }),
      ]);
    });

    it('filters by serverId', async () => {
      const result = await service.getFiltered({ serverId: 'srv-2' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('e-2');
    });

    it('filters by result', async () => {
      const result = await service.getFiltered({ result: 'success' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('e-1');
    });

    it('filters by file path search (case-insensitive substring)', async () => {
      const result = await service.getFiltered({ search: 'helper' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('e-3');
    });

    it('combines multiple filters with AND logic', async () => {
      const result = await service.getFiltered({ serverId: 'srv-1', result: 'success' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('e-1');
    });

    it('returns all entries when filter is empty', async () => {
      const result = await service.getFiltered({});
      expect(result).toHaveLength(3);
    });
  });

  describe('clear()', () => {
    it('removes the history file', async () => {
      await service.log([entry()]);
      await service.clear();

      const result = await service.getAll();
      expect(result).toEqual([]);
    });

    it('does not throw when file does not exist', async () => {
      await expect(service.clear()).resolves.not.toThrow();
    });
  });

  describe('enforceRetention()', () => {
    it('trims to maxEntries keeping most recent entries', async () => {
      const small = new UploadHistoryService(tmpDir, 2);
      await small.log([
        entry({ id: 'e-1', timestamp: 1000 }),
        entry({ id: 'e-2', timestamp: 2000 }),
        entry({ id: 'e-3', timestamp: 3000 }),
      ]);

      await small.enforceRetention();

      const result = await small.getAll();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('e-2');
      expect(result[1].id).toBe('e-3');
    });

    it('does nothing when entry count is within limit', async () => {
      await service.log([entry({ id: 'e-1' }), entry({ id: 'e-2' })]);

      await service.enforceRetention();

      const result = await service.getAll();
      expect(result).toHaveLength(2);
    });

    it('does nothing when file does not exist', async () => {
      await expect(service.enforceRetention()).resolves.not.toThrow();
    });
  });
});
