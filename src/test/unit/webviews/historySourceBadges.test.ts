import * as fs from 'fs';
import * as path from 'path';

// #31 design decision (signed off 2026-09-17): every Source badge in Upload
// History uses one neutral style. Colour is reserved for the Result column.
// Per-source rules (.source-manual, .source-save, ...) are what let later
// sources drift into three different looks, so none may exist.

const stylesheet = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', 'webview-ui', 'upload-history', 'style.css'),
  'utf8'
);

describe('Upload History source badge styles', () => {
  it('styles source badges with the shared .source-tag rule only', () => {
    const perSourceSelectors = stylesheet.match(/\.source-(?!tag\b)[a-z-]+/g) ?? [];
    expect(perSourceSelectors).toEqual([]);
  });

  it('gives .source-tag the neutral look: outline, dimmed text, no fill', () => {
    const rules = [...stylesheet.matchAll(/\.source-tag\s*\{([^}]*)\}/g)].map(match => match[1]).join('\n');
    expect(rules).toMatch(/border-color:\s*var\(--vscode-panel-border\)/);
    expect(rules).toMatch(/color:\s*var\(--vscode-descriptionForeground\)/);
    expect(rules).toMatch(/background:\s*transparent/);
  });
});
