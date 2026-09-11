import { translateIgnorePatterns, parseIgnoreFile } from '../../../../importers/vscodeSftp/ignoreTranslator';
import { normaliseContext } from '../../../../importers/vscodeSftp/context';

// Feature 35b, Q9/Q10: gitignore dialect (context-relative, both directions)
// → minimatch excludedPaths (workspace-relative, upload-only). Translate the
// compatible subset; name every pattern we can't translate — silent
// exclusion drift is the dangerous failure.

describe('translateIgnorePatterns', () => {
  it('passes plain names and simple globs through unchanged', () => {
    const result = translateIgnorePatterns(['.vscode', '.git', 'node_modules', '*.log', '.DS_Store', 'temp?.txt']);
    expect(result.excludedPaths).toEqual(['.vscode', '.git', 'node_modules', '*.log', '.DS_Store', 'temp?.txt']);
    expect(result.untranslatable).toEqual([]);
  });

  it('reports negations instead of guessing', () => {
    const result = translateIgnorePatterns(['*.log', '!important.log']);
    expect(result.excludedPaths).toEqual(['*.log']);
    expect(result.untranslatable).toEqual([
      { pattern: '!important.log', reason: expect.stringMatching(/negation/i) },
    ]);
  });

  it('reports anchored patterns (leading slash)', () => {
    const result = translateIgnorePatterns(['/build']);
    expect(result.excludedPaths).toEqual([]);
    expect(result.untranslatable[0]).toEqual({ pattern: '/build', reason: expect.stringMatching(/anchored/i) });
  });

  it('reports directory-only rules (trailing slash)', () => {
    const result = translateIgnorePatterns(['dist/']);
    expect(result.excludedPaths).toEqual([]);
    expect(result.untranslatable[0]).toEqual({ pattern: 'dist/', reason: expect.stringMatching(/directory-only/i) });
  });

  it('keeps patterns with an inner slash as workspace-relative paths', () => {
    const result = translateIgnorePatterns(['build/temp', 'src/**/*.test.js', '**/*.map']);
    expect(result.excludedPaths).toEqual(['build/temp', 'src/**/*.test.js', '**/*.map']);
  });

  it('prefixes inner-slash patterns with the context folder, leaving any-depth (**/) patterns alone', () => {
    const result = translateIgnorePatterns(['build/temp', '**/*.map', '*.log'], 'web');
    expect(result.excludedPaths).toEqual(['web/build/temp', '**/*.map', '*.log']);
  });

  it('skips blank lines and comments, trims whitespace, and de-duplicates', () => {
    const result = translateIgnorePatterns(['', '  ', '# a comment', ' node_modules ', 'node_modules']);
    expect(result.excludedPaths).toEqual(['node_modules']);
    expect(result.untranslatable).toEqual([]);
  });

  it('drops non-string entries with a reason', () => {
    const result = translateIgnorePatterns([42 as unknown as string, 'ok']);
    expect(result.excludedPaths).toEqual(['ok']);
    expect(result.untranslatable[0]).toEqual({ pattern: '42', reason: expect.stringMatching(/not a string/i) });
  });
});

describe('parseIgnoreFile', () => {
  it('splits lines, tolerating CRLF', () => {
    expect(parseIgnoreFile('node_modules\r\n*.log\n\n# c\ndist/')).toEqual(['node_modules', '*.log', '', '# c', 'dist/']);
  });
});

describe('normaliseContext', () => {
  it.each([
    [undefined, ''],
    ['', ''],
    ['.', ''],
    ['./', ''],
    ['/', ''],
    ['src', 'src'],
    ['./src/', 'src'],
    ['src\\app', 'src/app'],
    ['./web/../web/', 'web/../web'],
  ])('%p → %p', (input, expected) => {
    expect(normaliseContext(input)).toBe(expected);
  });
});
