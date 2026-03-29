import { PathResolver } from '../../../path/PathResolver';

const resolver = new PathResolver();
const workspaceRoot = '/workspace';

describe('PathResolver', () => {
  it('maps a local path to remote path using a single mapping', () => {
    const result = resolver.resolve('/workspace/src/app.php', workspaceRoot, {
      rootPath: '/var/www',
      mappings: [{ localPath: '/', remotePath: '' }],
      excludedPaths: [],
    });
    expect(result).toEqual({
      localPath: '/workspace/src/app.php',
      remotePath: '/var/www/src/app.php',
    });
  });

  it('uses the most-specific (longest) matching mapping when multiple match', () => {
    const result = resolver.resolve('/workspace/public/index.php', workspaceRoot, {
      rootPath: '/var/www',
      mappings: [
        { localPath: '/', remotePath: '' },
        { localPath: '/public', remotePath: 'public_html' },
      ],
      excludedPaths: [],
    });
    expect(result.remotePath).toBe('/var/www/public_html/index.php');
  });

  it('prepends server rootPath to the resolved remote path', () => {
    const result = resolver.resolve('/workspace/index.php', workspaceRoot, {
      rootPath: '/srv/app',
      mappings: [{ localPath: '/', remotePath: 'html' }],
      excludedPaths: [],
    });
    expect(result.remotePath).toBe('/srv/app/html/index.php');
  });

  it('uses rootPath as catch-all when mappings array is empty', () => {
    const result = resolver.resolve('/workspace/src/app.php', workspaceRoot, {
      rootPath: '/var/www',
      mappings: [],
      excludedPaths: [],
    });
    expect(result.remotePath).toBe('/var/www/src/app.php');
  });

  it('throws when no mapping covers the given local path', () => {
    expect(() =>
      resolver.resolve('/workspace/src/app.php', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [{ localPath: '/other', remotePath: 'other' }],
        excludedPaths: [],
      })
    ).toThrow(/No mapping found/);
  });

  it('handles mappings with trailing slashes consistently', () => {
    const result = resolver.resolve('/workspace/src/app.php', workspaceRoot, {
      rootPath: '/var/www/',
      mappings: [{ localPath: '/', remotePath: 'html/' }],
      excludedPaths: [],
    });
    expect(result.remotePath).toBe('/var/www/html/src/app.php');
  });

  it('resolves multiple files in one call via resolveAll', () => {
    const results = resolver.resolveAll(
      ['/workspace/a.php', '/workspace/b.php'],
      workspaceRoot,
      { rootPath: '/var/www', mappings: [{ localPath: '/', remotePath: '' }], excludedPaths: [] }
    );
    expect(results).toHaveLength(2);
    expect(results[0].remotePath).toBe('/var/www/a.php');
    expect(results[1].remotePath).toBe('/var/www/b.php');
  });

  it('respects excludedPaths — skips excluded files', () => {
    expect(() =>
      resolver.resolve('/workspace/node_modules/lodash/index.js', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: ['node_modules'],
      })
    ).toThrow(/excluded/i);
  });

  describe('rootPathOverride', () => {
    it('uses rootPathOverride instead of rootPath when set', () => {
      const result = resolver.resolve('/workspace/index.php', workspaceRoot, {
        rootPath: '/var/www',
        rootPathOverride: '/home/deploy/app',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: [],
      });
      expect(result.remotePath).toBe('/home/deploy/app/index.php');
    });

    it('falls back to rootPath when rootPathOverride is absent', () => {
      const result = resolver.resolve('/workspace/index.php', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: [],
      });
      expect(result.remotePath).toBe('/var/www/index.php');
    });

    it('falls back to rootPath when rootPathOverride is empty string', () => {
      const result = resolver.resolve('/workspace/index.php', workspaceRoot, {
        rootPath: '/var/www',
        rootPathOverride: '   ',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: [],
      });
      expect(result.remotePath).toBe('/var/www/index.php');
    });
  });
});
