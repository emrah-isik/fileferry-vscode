import * as fs from 'fs';
import { walkRemoteTree, walkLocalTree } from '../../../services/SyncTreeWalker';
import type { FileEntry } from '../../../transferService';

jest.mock('fs');

function fileEntry(name: string, type: FileEntry['type'], modifyTime: number): FileEntry {
  return { name, type, size: 0, modifyTime };
}

describe('walkRemoteTree', () => {
  function transferReturning(tree: Record<string, FileEntry[]>) {
    return {
      listDirectoryDetailed: jest.fn((dir: string) => {
        if (!(dir in tree)) {
          return Promise.reject(new Error(`No such directory: ${dir}`));
        }
        return Promise.resolve(tree[dir]);
      }),
    } as any;
  }

  it('recursively flattens files and descends into directories', async () => {
    const transfer = transferReturning({
      '/var/www': [
        fileEntry('index.php', '-', 100),
        fileEntry('css', 'd', 0),
      ],
      '/var/www/css': [fileEntry('app.css', '-', 200)],
    });

    const files = await walkRemoteTree(transfer, '/var/www');

    expect(files).toEqual([
      { remotePath: '/var/www/index.php', modifyTimeMs: 100 },
      { remotePath: '/var/www/css/app.css', modifyTimeMs: 200 },
    ]);
  });

  it('does not collect symlinks (never a deletable extra in v1)', async () => {
    const transfer = transferReturning({
      '/var/www': [fileEntry('index.php', '-', 100), fileEntry('current', 'l', 0)],
    });

    const files = await walkRemoteTree(transfer, '/var/www');

    expect(files.map(file => file.remotePath)).toEqual(['/var/www/index.php']);
  });

  it('treats a missing remote root as an empty tree (nothing to prune)', async () => {
    const transfer = transferReturning({}); // root listing rejects

    const files = await walkRemoteTree(transfer, '/var/www');

    expect(files).toEqual([]);
  });

  it('stops descending once cancellation is requested', async () => {
    const transfer = transferReturning({
      '/var/www': [fileEntry('a', 'd', 0)],
      '/var/www/a': [fileEntry('deep.php', '-', 100)],
    });
    const token = { isCancellationRequested: true } as any;

    const files = await walkRemoteTree(transfer, '/var/www', token);

    expect(files).toEqual([]);
    expect(transfer.listDirectoryDetailed).not.toHaveBeenCalled();
  });

  it('never descends into ignored directory names', async () => {
    const transfer = transferReturning({
      '/var/www': [fileEntry('index.php', '-', 100), fileEntry('.git', 'd', 0)],
      '/var/www/.git': [fileEntry('config', '-', 50)],
    });

    const files = await walkRemoteTree(transfer, '/var/www', undefined, new Set(['.git']));

    expect(files.map(file => file.remotePath)).toEqual(['/var/www/index.php']);
    expect(transfer.listDirectoryDetailed).not.toHaveBeenCalledWith('/var/www/.git');
  });
});

describe('walkLocalTree', () => {
  function dirent(name: string, kind: 'file' | 'dir') {
    return {
      name,
      isDirectory: () => kind === 'dir',
      isFile: () => kind === 'file',
      isSymbolicLink: () => false,
    };
  }

  beforeEach(() => jest.clearAllMocks());

  it('returns absolute paths of every regular file under the root', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
      if (dir === '/workspace/public') {
        return [dirent('index.php', 'file'), dirent('css', 'dir')];
      }
      if (dir === '/workspace/public/css') {
        return [dirent('app.css', 'file')];
      }
      return [];
    });

    const files = walkLocalTree('/workspace/public');

    expect(files).toEqual([
      '/workspace/public/index.php',
      '/workspace/public/css/app.css',
    ]);
  });

  it('returns nothing when the root does not exist', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    expect(walkLocalTree('/workspace/missing')).toEqual([]);
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('never descends into ignored directory names', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
      if (dir === '/workspace') {
        return [dirent('app.js', 'file'), dirent('.git', 'dir'), dirent('node_modules', 'dir')];
      }
      return [dirent('should-not-be-seen', 'file')];
    });

    const files = walkLocalTree('/workspace', new Set(['.git', 'node_modules']));

    expect(files).toEqual(['/workspace/app.js']);
    expect(fs.readdirSync).not.toHaveBeenCalledWith('/workspace/.git', expect.anything());
    expect(fs.readdirSync).not.toHaveBeenCalledWith('/workspace/node_modules', expect.anything());
  });
});
