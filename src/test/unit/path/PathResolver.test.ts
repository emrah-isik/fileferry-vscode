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

  describe('glob-based excludedPaths', () => {
    const serverConfig = (excludedPaths: string[]) => ({
      rootPath: '/var/www',
      mappings: [{ localPath: '/', remotePath: '' }] as Array<{ localPath: string; remotePath: string }>,
      excludedPaths,
    });

    it('excludes files matching a wildcard extension pattern like *.log', () => {
      expect(() =>
        resolver.resolve('/workspace/debug.log', workspaceRoot, serverConfig(['*.log']))
      ).toThrow(/excluded/i);
    });

    it('excludes nested files matching a wildcard extension pattern', () => {
      expect(() =>
        resolver.resolve('/workspace/logs/app.log', workspaceRoot, serverConfig(['*.log']))
      ).toThrow(/excluded/i);
    });

    it('does not exclude files that do not match the glob', () => {
      const result = resolver.resolve('/workspace/src/app.php', workspaceRoot, serverConfig(['*.log']));
      expect(result.remotePath).toBe('/var/www/src/app.php');
    });

    it('excludes dotfiles like .env', () => {
      expect(() =>
        resolver.resolve('/workspace/.env', workspaceRoot, serverConfig(['.env']))
      ).toThrow(/excluded/i);
    });

    it('excludes files matching a double-star glob like **/*.tmp', () => {
      expect(() =>
        resolver.resolve('/workspace/src/deep/nested/cache.tmp', workspaceRoot, serverConfig(['**/*.tmp']))
      ).toThrow(/excluded/i);
    });

    it('excludes a directory pattern with trailing slash glob', () => {
      expect(() =>
        resolver.resolve('/workspace/dist/bundle.js', workspaceRoot, serverConfig(['dist']))
      ).toThrow(/excluded/i);
    });

    it('supports multiple exclude patterns', () => {
      const config = serverConfig(['*.log', 'node_modules', '.env']);
      expect(() => resolver.resolve('/workspace/error.log', workspaceRoot, config)).toThrow(/excluded/i);
      expect(() => resolver.resolve('/workspace/node_modules/x/y.js', workspaceRoot, config)).toThrow(/excluded/i);
      expect(() => resolver.resolve('/workspace/.env', workspaceRoot, config)).toThrow(/excluded/i);
      // Non-excluded file should pass through
      const result = resolver.resolve('/workspace/src/index.php', workspaceRoot, config);
      expect(result.remotePath).toBe('/var/www/src/index.php');
    });

    it('excludes files matching a negated segment like vendor/**', () => {
      expect(() =>
        resolver.resolve('/workspace/vendor/autoload.php', workspaceRoot, serverConfig(['vendor/**']))
      ).toThrow(/excluded/i);
    });
  });

  describe('ignoreExclusions', () => {
    it('skips exclusion checks when ignoreExclusions is true', () => {
      const result = resolver.resolve('/workspace/debug.log', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: ['*.log'],
        ignoreExclusions: true,
      });
      expect(result.remotePath).toBe('/var/www/debug.log');
    });

    it('still excludes when ignoreExclusions is false', () => {
      expect(() =>
        resolver.resolve('/workspace/debug.log', workspaceRoot, {
          rootPath: '/var/www',
          mappings: [{ localPath: '/', remotePath: '' }],
          excludedPaths: ['*.log'],
          ignoreExclusions: false,
        })
      ).toThrow(/excluded/i);
    });

    it('still excludes when ignoreExclusions is not set', () => {
      expect(() =>
        resolver.resolve('/workspace/debug.log', workspaceRoot, {
          rootPath: '/var/www',
          mappings: [{ localPath: '/', remotePath: '' }],
          excludedPaths: ['*.log'],
        })
      ).toThrow(/excluded/i);
    });
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

  describe('resolveLocalPath (reverse: remote → local)', () => {
    it('maps a remote path back to a local workspace path', () => {
      const result = resolver.resolveLocalPath('/var/www/src/app.php', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: [],
      });
      expect(result).toBe('/workspace/src/app.php');
    });

    it('uses the most-specific matching mapping', () => {
      const result = resolver.resolveLocalPath('/var/www/public_html/index.php', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [
          { localPath: '/', remotePath: '' },
          { localPath: '/public', remotePath: 'public_html' },
        ],
        excludedPaths: [],
      });
      expect(result).toBe('/workspace/public/index.php');
    });

    it('handles rootPathOverride', () => {
      const result = resolver.resolveLocalPath('/home/deploy/app/index.php', workspaceRoot, {
        rootPath: '/var/www',
        rootPathOverride: '/home/deploy/app',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: [],
      });
      expect(result).toBe('/workspace/index.php');
    });

    it('handles mapping with non-empty remotePath', () => {
      const result = resolver.resolveLocalPath('/srv/app/html/src/app.php', workspaceRoot, {
        rootPath: '/srv/app',
        mappings: [{ localPath: '/', remotePath: 'html' }],
        excludedPaths: [],
      });
      expect(result).toBe('/workspace/src/app.php');
    });

    it('returns null when remote path does not match rootPath', () => {
      const result = resolver.resolveLocalPath('/other/path/file.php', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: [],
      });
      expect(result).toBeNull();
    });

    it('returns null when no mapping matches the remote subpath', () => {
      const result = resolver.resolveLocalPath('/var/www/nomatch/file.php', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [{ localPath: '/public', remotePath: 'public_html' }],
        excludedPaths: [],
      });
      expect(result).toBeNull();
    });

    it('handles file directly in rootPath with empty remotePath mapping', () => {
      const result = resolver.resolveLocalPath('/var/www/index.php', workspaceRoot, {
        rootPath: '/var/www',
        mappings: [{ localPath: '/', remotePath: '' }],
        excludedPaths: [],
      });
      expect(result).toBe('/workspace/index.php');
    });
  });
});
