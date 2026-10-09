import * as fs from 'fs';
import * as path from 'path';

// Marketplace search weighs the display name far above the description and the
// keywords: on 2026-10-09 the query "sftp" ranked 88 of its top 100 results by a
// display name containing "SFTP", and FileFerry, with the word only in its
// description, sat outside the top 100. The extension id cannot change, so the
// display name carries the protocol words, and the README's first sentence and
// the listing description carry the pitch that distinguishes FileFerry from the
// maintained vscode-sftp forks.

const root = path.resolve(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  displayName: string;
  description: string;
};
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

describe('listing name and pitch', () => {
  it('keeps SFTP and FTP as separate words in the display name', () => {
    expect(manifest.displayName).toMatch(/^FileFerry - SFTP\/FTP Deploy$/);
  });

  it('describes the git-first model instead of claiming to be the maintained alternative', () => {
    expect(manifest.description).toContain('built around git');
    expect(manifest.description).not.toMatch(/actively maintained/i);
  });

  it('opens the README with the same pitch', () => {
    const firstParagraph = readme.split(/\n\s*\n/).find((block) => /^[A-Z]/.test(block)) ?? '';
    expect(firstParagraph).toContain('built around git');
    expect(firstParagraph).not.toMatch(/actively maintained/i);
  });

  it('names the maintained fork honestly under the comparison table', () => {
    expect(readme).toContain('SFTPresso');
  });
});
