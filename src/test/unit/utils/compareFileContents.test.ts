import { compareFileContents } from '../../../utils/compareFileContents';

const buf = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('compareFileContents', () => {
  it('returns "identical" for byte-for-byte equal buffers', () => {
    expect(compareFileContents(buf('line one\nline two\n'), buf('line one\nline two\n'))).toBe('identical');
  });

  it('returns "identical" for two empty buffers', () => {
    expect(compareFileContents(Buffer.alloc(0), Buffer.alloc(0))).toBe('identical');
  });

  it('returns "eol-only" when the only difference is CRLF vs LF', () => {
    expect(compareFileContents(buf('a\r\nb\r\nc'), buf('a\nb\nc'))).toBe('eol-only');
  });

  it('returns "eol-only" when the only difference is a trailing newline', () => {
    expect(compareFileContents(buf('hello\n'), buf('hello'))).toBe('eol-only');
  });

  it('returns "eol-only" for a mix of CRLF and a trailing-newline difference', () => {
    expect(compareFileContents(buf('a\r\nb\r\n'), buf('a\nb'))).toBe('eol-only');
  });

  it('returns "different" when one real character changed', () => {
    expect(compareFileContents(buf('hello world'), buf('hello werld'))).toBe('different');
  });

  it('returns "different" when content differs even if line endings also differ', () => {
    expect(compareFileContents(buf('a\r\nb\r\nc'), buf('a\nb\nX'))).toBe('different');
  });

  it('returns "different" when one file has an extra line', () => {
    expect(compareFileContents(buf('a\nb\n'), buf('a\nb\nc\n'))).toBe('different');
  });

  it('does not treat a leading whitespace change as eol-only', () => {
    expect(compareFileContents(buf('  indented'), buf('indented'))).toBe('different');
  });

  it('handles a lone CR (old Mac line ending) as an EOL difference', () => {
    expect(compareFileContents(buf('a\rb'), buf('a\nb'))).toBe('eol-only');
  });
});
