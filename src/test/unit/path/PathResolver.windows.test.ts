// Windows coverage for PathResolver, run on a POSIX CI box by swapping the
// `path` module for its win32 implementation: path.relative() then yields
// '\'-separated paths and path.sep is '\'. The mock is global to the module
// registry, so these tests live in their own file.
//
// Regression tests for #1 (thanks @shanto): `relativeLocal` feeds the mapping
// match, the exclusion matcher, and the remote-path builder, all of which
// assume '/' separators. Before the fix, all three broke on Windows.
jest.mock('path', () => jest.requireActual('path').win32);

import { PathResolver } from '../../../path/PathResolver';

const resolver = new PathResolver();
const workspaceRoot = 'C:\\workspace';

const baseConfig = {
  rootPath: '/var/www/html',
  mappings: [{ localPath: '/public', remotePath: 'public_html' }],
  excludedPaths: ['dist/**'],
};

describe('PathResolver with Windows path separators', () => {
  it('matches a nested mapping (the reported bug: "No mapping found")', () => {
    const result = resolver.resolve('C:\\workspace\\public\\index.php', workspaceRoot, baseConfig);
    expect(result.remotePath).toBe('/var/www/html/public_html/index.php');
  });

  it('never leaks a backslash into the remote path', () => {
    const result = resolver.resolve('C:\\workspace\\public\\css\\site.css', workspaceRoot, baseConfig);
    expect(result.remotePath).not.toContain('\\');
    expect(result.remotePath).toBe('/var/www/html/public_html/css/site.css');
  });

  // The quiet one: excludedPaths were matching nothing on Windows, so
  // dist/ and node_modules/ could be uploaded.
  it('still applies exclusion globs to backslash paths', () => {
    expect(() => resolver.resolve('C:\\workspace\\dist\\bundle.js', workspaceRoot, {
      ...baseConfig,
      mappings: [{ localPath: '/', remotePath: '' }],
    })).toThrow(/excluded/);
  });

  // On Windows, path.relative() across drives returns an ABSOLUTE path rather
  // than a '../…' escape, so a startsWith('..') check alone would miss it.
  // See issue #3.
  it('throws for a file on a different drive (relative path comes back absolute)', () => {
    expect(() => resolver.resolve('D:\\other\\secrets.txt', workspaceRoot, baseConfig))
      .toThrow(/outside the workspace/i);
  });

  it('throws for a parent-relative escape on the same drive', () => {
    expect(() => resolver.resolve('C:\\workspace\\..\\windows\\hosts', workspaceRoot, baseConfig))
      .toThrow(/outside the workspace/i);
  });

  it('still auto-excludes FileFerry artifacts', () => {
    expect(() => resolver.resolve('C:\\workspace\\.vscode\\fileferry.json', workspaceRoot, {
      ...baseConfig,
      mappings: [{ localPath: '/', remotePath: '' }],
    })).toThrow(/excluded/);
  });
});
