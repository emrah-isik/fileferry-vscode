import * as fs from 'fs';
import * as path from 'path';

// Feature 36 rider: a command that only makes sense on a right-clicked Explorer
// folder gets no arguments from the Command Palette (VS Code passes none and
// never exposes the Explorer selection), so offering it there can only produce
// a "no folder selected" warning. Every such command must be hidden from the
// palette with a `when: "false"` entry, as the remote-browser commands are.

interface MenuEntry { command: string; when?: string; group?: string }
interface CommandEntry { command: string; title: string }

const manifest = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')
) as { contributes: { menus: Record<string, MenuEntry[]>; commands: CommandEntry[] } };

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

  // Polish 2026-11: Upload, Upload to Servers and Compare with Remote already
  // work from the editor via keybindings and the palette; the right-click
  // menus (text area and editor tab) were the only missing entry point.
  describe('editor right-click menus', () => {
    const expectedCommands = ['fileferry.uploadSelected', 'fileferry.uploadToServers', 'fileferry.showRemoteDiff'];

    for (const menuId of ['editor/context', 'editor/title/context']) {
      it(`${menuId} offers the three file commands, guarded to the file scheme`, () => {
        const entries = manifest.contributes.menus[menuId] ?? [];
        expect(entries.map(entry => entry.command)).toEqual(expectedCommands);
        for (const entry of entries) {
          expect(entry.when).toBe('resourceScheme == file');
        }
      });

      it(`${menuId} uses the Explorer menu's group ids so the block and ordering match`, () => {
        const explorerGroups = new Map(
          (manifest.contributes.menus['explorer/context'] ?? []).map(entry => [entry.command, entry.group])
        );
        for (const entry of manifest.contributes.menus[menuId] ?? []) {
          expect(entry.group).toBe(explorerGroups.get(entry.command));
        }
      });
    }

    it('never offers the folder-only sync command in an editor menu', () => {
      for (const menuId of ['editor/context', 'editor/title/context']) {
        const commands = (manifest.contributes.menus[menuId] ?? []).map(entry => entry.command);
        expect(commands).not.toContain('fileferry.syncFolderToRemote');
      }
    });
  });

  // Polish 2026-11: the GUIDE listed "FileFerry: Test Connection" as a palette
  // command, but the only test-connection command was the Servers-tree one,
  // hidden from the palette (it needs a server item). A palette command that
  // picks the server first closes the gap.
  describe('Test Connection from the Command Palette', () => {
    it('contributes fileferry.testConnection with the FileFerry: prefix', () => {
      const entry = manifest.contributes.commands.find(command => command.command === 'fileferry.testConnection');
      expect(entry?.title).toBe('FileFerry: Test Connection');
    });

    it('keeps the palette command visible and the Servers-tree one hidden', () => {
      const hiddenFromPalette = (manifest.contributes.menus.commandPalette ?? [])
        .filter(entry => entry.when === 'false')
        .map(entry => entry.command);
      expect(hiddenFromPalette).toContain('fileferry.servers.testConnection');
      expect(hiddenFromPalette).not.toContain('fileferry.testConnection');
    });
  });
});
