import { walkRemoteTreeStrict } from '../../../services/StrictRemoteTreeWalker';
import { FileEntry } from '../../../transferService';

function entry(name: string, type: 'd' | '-' | 'l', size: number = 0): FileEntry {
  return { name, type, size, modifyTime: 1710000000000 };
}

describe('walkRemoteTreeStrict', () => {
  const listings = new Map<string, FileEntry[]>();
  const lister = {
    listDirectory: jest.fn(async (remotePath: string) => {
      const listing = listings.get(remotePath);
      if (listing === undefined) {
        throw new Error(`Permission denied: ${remotePath}`);
      }
      return listing;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    listings.clear();
  });

  it('collects files with sizes and directories parent-first, including EMPTY directories', async () => {
    listings.set('/var/www/assets', [
      entry('logo.png', '-', 1000),
      entry('css', 'd'),
      entry('empty', 'd'),
    ]);
    listings.set('/var/www/assets/css', [
      entry('site.css', '-', 200),
      entry('vendor', 'd'),
    ]);
    listings.set('/var/www/assets/css/vendor', [entry('reset.css', '-', 50)]);
    listings.set('/var/www/assets/empty', []);

    const snapshot = await walkRemoteTreeStrict(lister, '/var/www/assets');

    expect(snapshot.files).toEqual([
      { remotePath: '/var/www/assets/logo.png', size: 1000 },
      { remotePath: '/var/www/assets/css/site.css', size: 200 },
      { remotePath: '/var/www/assets/css/vendor/reset.css', size: 50 },
    ]);
    // Parent-first: css before css/vendor; the empty directory IS emitted —
    // the copy side must recreate it.
    expect(snapshot.directories).toEqual([
      '/var/www/assets/css',
      '/var/www/assets/css/vendor',
      '/var/www/assets/empty',
    ]);
    expect(snapshot.totalBytes).toBe(1250);
  });

  it('skips symlinks but records their paths for the confirmation', async () => {
    listings.set('/var/www/assets', [
      entry('current', 'l'),
      entry('logo.png', '-', 10),
    ]);

    const snapshot = await walkRemoteTreeStrict(lister, '/var/www/assets');

    expect(snapshot.symlinks).toEqual(['/var/www/assets/current']);
    expect(snapshot.files).toHaveLength(1);
    // A symlink is never descended into, even if it points at a directory.
    expect(lister.listDirectory).not.toHaveBeenCalledWith('/var/www/assets/current');
  });

  it('ignores . and .. entries some servers include in listings', async () => {
    listings.set('/var/www/assets', [
      entry('.', 'd'),
      entry('..', 'd'),
      entry('logo.png', '-', 10),
    ]);

    const snapshot = await walkRemoteTreeStrict(lister, '/var/www/assets');

    expect(snapshot.directories).toEqual([]);
    expect(snapshot.files).toHaveLength(1);
  });

  it('THROWS when the root listing fails — never an empty tree', async () => {
    await expect(walkRemoteTreeStrict(lister, '/var/www/missing')).rejects.toThrow('Permission denied');
  });

  it('THROWS when a nested listing fails — a partial tree must never look complete', async () => {
    listings.set('/var/www/assets', [entry('css', 'd'), entry('logo.png', '-', 10)]);
    // /var/www/assets/css deliberately absent from the listings map

    await expect(walkRemoteTreeStrict(lister, '/var/www/assets')).rejects.toThrow('Permission denied');
  });

  it('does not double the slash when walking from the filesystem root', async () => {
    listings.set('/', [entry('file.txt', '-', 5)]);

    const snapshot = await walkRemoteTreeStrict(lister, '/');

    expect(snapshot.files).toEqual([{ remotePath: '/file.txt', size: 5 }]);
  });
});
