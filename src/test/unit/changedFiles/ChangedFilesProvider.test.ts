import * as vscode from 'vscode';
import { ChangedFilesProvider } from '../../../changedFiles/ChangedFilesProvider';
import type { GitService } from '../../../gitService';
import type { GitFile } from '../../../types';

function makeGitFile(partial: Partial<GitFile>): GitFile {
  return {
    absolutePath: '/workspace/a.php',
    relativePath: 'a.php',
    workspaceRoot: '/workspace',
    status: 'modified',
    checked: false,
    ...partial,
  };
}

function makeGitServiceMock(files: GitFile[]): GitService {
  return {
    getChangedFiles: jest.fn().mockReturnValue(files),
  } as unknown as GitService;
}

describe('ChangedFilesProvider', () => {
  describe('getChildren — happy path', () => {
    it('returns one TreeItem per changed file', async () => {
      const files = [
        makeGitFile({ absolutePath: '/workspace/a.php', relativePath: 'a.php' }),
        makeGitFile({ absolutePath: '/workspace/b.php', relativePath: 'b.php' }),
        makeGitFile({ absolutePath: '/workspace/c.php', relativePath: 'c.php' }),
      ];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const items = await provider.getChildren();

      expect(items).toHaveLength(3);
    });

    it('sets resourceUri on each item so VSCode applies native file icons and git decorations', async () => {
      const files = [makeGitFile({ absolutePath: '/workspace/src/index.php', relativePath: 'src/index.php' })];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();

      expect(item.resourceUri?.fsPath).toBe('/workspace/src/index.php');
    });

    it('uses the parent directory path as the description (SCM-style)', async () => {
      const files = [
        makeGitFile({ absolutePath: '/workspace/public/assets/style.css', relativePath: 'public/assets/style.css' }),
      ];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();

      expect(item.description).toBe('public/assets');
    });

    it('shows an empty description for files at the workspace root', async () => {
      const files = [makeGitFile({ absolutePath: '/workspace/README.md', relativePath: 'README.md' })];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();

      expect(item.description === '' || item.description === undefined).toBe(true);
    });

    it('attaches a click command that opens the SCM-style diff (git.openChange) for tracked changes', async () => {
      const files = [
        makeGitFile({ absolutePath: '/workspace/a.php', relativePath: 'a.php', status: 'modified' }),
      ];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();

      expect(item.command).toBeDefined();
      expect(item.command?.command).toBe('git.openChange');
      expect(item.command?.arguments?.[0]).toEqual(item.resourceUri);
    });

    it('opens the file directly (vscode.open) for untracked files since there is no diff base', async () => {
      const files = [
        makeGitFile({ absolutePath: '/workspace/new.php', relativePath: 'new.php', status: 'untracked' }),
      ];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();

      expect(item.command?.command).toBe('vscode.open');
      expect(item.command?.arguments?.[0]).toEqual(item.resourceUri);
    });

    it('sorts items alphabetically by relative path', async () => {
      const files = [
        makeGitFile({ absolutePath: '/workspace/src/z.php', relativePath: 'src/z.php' }),
        makeGitFile({ absolutePath: '/workspace/a.php', relativePath: 'a.php' }),
        makeGitFile({ absolutePath: '/workspace/src/a.php', relativePath: 'src/a.php' }),
      ];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const items = await provider.getChildren();

      expect(items.map(i => i.resourceUri?.fsPath)).toEqual([
        '/workspace/a.php',
        '/workspace/src/a.php',
        '/workspace/src/z.php',
      ]);
    });

    it('uses None collapsible state (flat list, no nesting)', async () => {
      const files = [makeGitFile({})];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();

      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });
  });

  describe('getChildren — empty / degenerate states', () => {
    it('returns a single "No changes" item when git reports zero files', async () => {
      const provider = new ChangedFilesProvider(makeGitServiceMock([]), () => '/workspace');

      const items = await provider.getChildren();

      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('No changes');
    });

    it('the "No changes" item has no resourceUri and no click command', async () => {
      const provider = new ChangedFilesProvider(makeGitServiceMock([]), () => '/workspace');

      const [placeholder] = await provider.getChildren();

      expect(placeholder.resourceUri).toBeUndefined();
      expect(placeholder.command).toBeUndefined();
    });

    it('returns the "No changes" item when no workspace root is open', async () => {
      const provider = new ChangedFilesProvider(makeGitServiceMock([]), () => undefined);

      const items = await provider.getChildren();

      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('No changes');
    });
  });

  describe('getTreeItem', () => {
    it('returns the element unchanged (items are pre-built TreeItems)', async () => {
      const files = [makeGitFile({})];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();
      expect(provider.getTreeItem(item)).toBe(item);
    });
  });

  describe('refresh', () => {
    it('fires onDidChangeTreeData when refresh() is called', () => {
      const provider = new ChangedFilesProvider(makeGitServiceMock([]), () => '/workspace');
      const listener = jest.fn();
      provider.onDidChangeTreeData(listener);

      provider.refresh();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('re-reads git state on every getChildren call', async () => {
      const gitMock = makeGitServiceMock([]);
      const provider = new ChangedFilesProvider(gitMock, () => '/workspace');

      await provider.getChildren();
      await provider.getChildren();
      await provider.getChildren();

      expect(gitMock.getChangedFiles).toHaveBeenCalledTimes(3);
    });
  });

  describe('children of items (flat list contract)', () => {
    it('returns an empty array for getChildren(item) — no nesting', async () => {
      const files = [makeGitFile({})];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();
      const children = await provider.getChildren(item);

      expect(children).toEqual([]);
    });
  });

  describe('label derivation', () => {
    it('uses the file basename as label', async () => {
      const files = [
        makeGitFile({ absolutePath: '/workspace/public/assets/style.css', relativePath: 'public/assets/style.css' }),
      ];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();

      expect(item.label).toBe('style.css');
    });

    it('handles paths with no parent directory cleanly', async () => {
      const files = [makeGitFile({ absolutePath: '/workspace/Makefile', relativePath: 'Makefile' })];
      const provider = new ChangedFilesProvider(makeGitServiceMock(files), () => '/workspace');

      const [item] = await provider.getChildren();

      expect(item.label).toBe('Makefile');
    });
  });
});
