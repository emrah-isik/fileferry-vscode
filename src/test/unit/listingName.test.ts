import * as fs from 'fs';
import * as path from 'path';

// Marketplace search weighs the display name far above the description and the
// keywords: on 2026-10-09 the query "sftp" ranked 88 of its top 100 results by a
// display name containing "SFTP", and FileFerry, with the word only in its
// description, sat outside the top 100. The extension id cannot change, so the
// display name carries the protocol words. The listing description and the
// README's first sentence lead with what FileFerry is (git-aware deploy with a
// confirmation and no secrets in the project config) rather than with
// "vscode-sftp alternative": maintained forks of vscode-sftp exist, so that
// claim no longer distinguishes anything. vscode-sftp stays a door (the import
// command and the "Coming from vscode-sftp?" section), not the identity.

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

  it('leads the description with what FileFerry is, not with vscode-sftp', () => {
    expect(manifest.description).toMatch(/^Git-aware SFTP\/FTP deploy/);
    expect(manifest.description).not.toMatch(/vscode-sftp|actively maintained/i);
  });

  it('opens the README with the same pitch', () => {
    const firstParagraph = readme.split(/\n\s*\n/).find((block) => /^[A-Z]/.test(block)) ?? '';
    expect(firstParagraph).toMatch(/^Git-aware SFTP\/FTP deploy/);
    expect(firstParagraph).not.toMatch(/vscode-sftp|actively maintained/i);
  });

  it('admits under the comparison table that maintained forks exist and that FileFerry is not a drop-in', () => {
    expect(readme).toContain('Maintained forks of vscode-sftp exist');
    expect(readme).toContain('not a drop-in');
  });
});
