import * as fs from 'fs';
import * as path from 'path';

// Every FileFerry webview ships a CSP of `style-src ${webview.cspSource}` with
// no 'unsafe-inline', so an inline `style="..."` attribute in a template is
// silently dropped by the browser (found in the 2026-09-15 Cursor pass, G1:
// the Excluded Paths heading lost its top margin). Styling belongs in the
// stylesheet; this guard keeps inline style attributes out of every template.

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');

function listFiles(directory: string, extensions: string[]): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(fullPath, extensions));
    } else if (extensions.includes(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('webview templates and scripts', () => {
  const templateFiles = [
    ...listFiles(path.join(repositoryRoot, 'webview-ui'), ['.js', '.html']),
    ...listFiles(path.join(repositoryRoot, 'src', 'ui', 'webviews'), ['.ts']),
  ];

  it('finds the webview sources to check', () => {
    expect(templateFiles.length).toBeGreaterThan(0);
  });

  it('contain no inline style attributes (blocked by the webview CSP)', () => {
    const offenders: string[] = [];
    for (const file of templateFiles) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/\sstyle="/.test(line) || /setAttribute\(\s*['"]style['"]/.test(line)) {
          offenders.push(`${path.relative(repositoryRoot, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
