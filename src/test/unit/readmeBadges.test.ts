import * as fs from 'fs';
import * as path from 'path';

// shields.io retired its whole visual-studio-marketplace badge family: the URL
// still answers 200, but the image reads "retired badge". The README text ships
// inside the package, so a dead badge sits at the top of both listings until the
// next publish. The Marketplace badge therefore comes from
// vsmarketplacebadges.dev, a host vsce trusts for SVG images.

const readme = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'README.md'), 'utf8');

describe('README badges', () => {
  it('does not use the retired shields.io Marketplace badges', () => {
    expect(readme).not.toMatch(/img\.shields\.io\/visual-studio-marketplace/);
  });

  it('shows the Marketplace version from vsmarketplacebadges.dev, linked to the listing', () => {
    expect(readme).toContain(
      '[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/esidevlabs.fileferry.svg)]'
      + '(https://marketplace.visualstudio.com/items?itemName=esidevlabs.fileferry)'
    );
  });
});
