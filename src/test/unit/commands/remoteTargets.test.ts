import { normalizeRemoteTargets, dropDescendantTargets } from '../../../commands/remoteTargets';
import { RemoteFileItem, RemoteEntry } from '../../../remoteBrowser/RemoteFileItem';

function makeItem(overrides: Partial<RemoteEntry> & { remotePath: string }): RemoteFileItem {
  const entry: RemoteEntry = {
    name: overrides.remotePath.split('/').pop() || overrides.remotePath,
    type: '-',
    size: 0,
    modifyTime: 0,
    ...overrides,
  };
  return new RemoteFileItem(entry);
}

describe('normalizeRemoteTargets', () => {
  it('returns the clicked item when no selection is passed', () => {
    const clickedItem = makeItem({ remotePath: '/var/www/app.log' });

    const targets = normalizeRemoteTargets(clickedItem, undefined);

    expect(targets).toEqual([clickedItem]);
  });

  it('returns the clicked item when the selection is empty', () => {
    const clickedItem = makeItem({ remotePath: '/var/www/app.log' });

    const targets = normalizeRemoteTargets(clickedItem, []);

    expect(targets).toEqual([clickedItem]);
  });

  it('returns the full selection when several items are selected', () => {
    const clickedItem = makeItem({ remotePath: '/var/www/a.txt' });
    const otherItem = makeItem({ remotePath: '/var/www/b.txt' });

    const targets = normalizeRemoteTargets(clickedItem, [clickedItem, otherItem]);

    expect(targets).toEqual([clickedItem, otherItem]);
  });

  it('filters the connection-error placeholder out of a selection', () => {
    const placeholderItem = makeItem({ remotePath: '', name: 'Connection failed' });
    const realItem = makeItem({ remotePath: '/var/www/a.txt' });

    const targets = normalizeRemoteTargets(realItem, [placeholderItem, realItem]);

    expect(targets).toEqual([realItem]);
  });

  it('returns an empty list when the clicked item is undefined and there is no selection', () => {
    const targets = normalizeRemoteTargets(undefined, undefined);

    expect(targets).toEqual([]);
  });

  it('returns an empty list when the clicked item itself is the placeholder', () => {
    const placeholderItem = makeItem({ remotePath: '', name: 'Connection failed' });

    const targets = normalizeRemoteTargets(placeholderItem, undefined);

    expect(targets).toEqual([]);
  });
});

describe('dropDescendantTargets', () => {
  it('keeps unrelated entries untouched and in order', () => {
    const firstItem = makeItem({ remotePath: '/var/www/a.txt' });
    const secondItem = makeItem({ remotePath: '/var/log/app.log' });
    const thirdItem = makeItem({ remotePath: '/etc/nginx', type: 'd' });

    const result = dropDescendantTargets([firstItem, secondItem, thirdItem]);

    expect(result).toEqual([firstItem, secondItem, thirdItem]);
  });

  it('drops a file that sits inside a selected directory', () => {
    const directoryItem = makeItem({ remotePath: '/var/www/logs', type: 'd' });
    const childFileItem = makeItem({ remotePath: '/var/www/logs/app.log' });

    const result = dropDescendantTargets([directoryItem, childFileItem]);

    expect(result).toEqual([directoryItem]);
  });

  it('drops a nested directory inside a selected directory, regardless of order', () => {
    const childDirectoryItem = makeItem({ remotePath: '/var/www/logs/archive', type: 'd' });
    const parentDirectoryItem = makeItem({ remotePath: '/var/www/logs', type: 'd' });

    const result = dropDescendantTargets([childDirectoryItem, parentDirectoryItem]);

    expect(result).toEqual([parentDirectoryItem]);
  });

  it('drops entries at any depth below a selected directory', () => {
    const directoryItem = makeItem({ remotePath: '/var/www', type: 'd' });
    const deepFileItem = makeItem({ remotePath: '/var/www/logs/archive/2026/app.log' });

    const result = dropDescendantTargets([directoryItem, deepFileItem]);

    expect(result).toEqual([directoryItem]);
  });

  it('keeps a sibling whose name merely starts with the directory name', () => {
    const directoryItem = makeItem({ remotePath: '/var/www/app', type: 'd' });
    const siblingItem = makeItem({ remotePath: '/var/www/app2/index.php' });

    const result = dropDescendantTargets([directoryItem, siblingItem]);

    expect(result).toEqual([directoryItem, siblingItem]);
  });

  it('treats a symlink to a directory as a parent for dedupe', () => {
    const symlinkDirectoryItem = makeItem({ remotePath: '/var/www/current', type: 'l', symlinkTarget: 'd' });
    const childItem = makeItem({ remotePath: '/var/www/current/index.php' });

    const result = dropDescendantTargets([symlinkDirectoryItem, childItem]);

    expect(result).toEqual([symlinkDirectoryItem]);
  });

  it('does not treat a plain file as a parent', () => {
    const fileItem = makeItem({ remotePath: '/var/www/app' });
    const lookalikeChildItem = makeItem({ remotePath: '/var/www/app/index.php' });

    const result = dropDescendantTargets([fileItem, lookalikeChildItem]);

    expect(result).toEqual([fileItem, lookalikeChildItem]);
  });

  it('drops everything under a selected root directory', () => {
    const rootItem = makeItem({ remotePath: '/', type: 'd', name: '/' });
    const childItem = makeItem({ remotePath: '/var/www/a.txt' });
    const otherChildItem = makeItem({ remotePath: '/etc/nginx', type: 'd' });

    const result = dropDescendantTargets([rootItem, childItem, otherChildItem]);

    expect(result).toEqual([rootItem]);
  });
});
