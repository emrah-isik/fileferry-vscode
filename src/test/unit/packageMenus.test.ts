import * as fs from 'fs';
import * as path from 'path';

// Feature 36 rider: a command that only makes sense on a right-clicked Explorer
// folder gets no arguments from the Command Palette (VS Code passes none and
// never exposes the Explorer selection), so offering it there can only produce
// a "no folder selected" warning. Every such command must be hidden from the
// palette with a `when: "false"` entry, as the remote-browser commands are.

interface MenuEntry { command: string; when?: string }

const manifest = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')
) as { contributes: { menus: Record<string, MenuEntry[]> } };

describe('package.json menus', () => {
  it('hides every folder-only Explorer command from the Command Palette', () => {
    const explorerFolderCommands = (manifest.contributes.menus['explorer/context'] ?? [])
      .filter(entry => /explorerResourceIsFolder/.test(entry.when ?? ''))
      .map(entry => entry.command);
    expect(explorerFolderCommands.length).toBeGreaterThan(0);

    const hiddenFromPalette = (manifest.contributes.menus.commandPalette ?? [])
      .filter(entry => entry.when === 'false')
      .map(entry => entry.command);

    const offeredInPalette = explorerFolderCommands.filter(command => !hiddenFromPalette.includes(command));
    expect(offeredInPalette).toEqual([]);
  });
});
