import { GitPanelProvider, WorkspaceGroup } from '../gitPanelProvider';
import { GitFile } from '../types';

// GitPanelProvider is pure logic — no VSCode UI calls in the constructor.
// We mock only what TreeItem needs.
jest.mock('vscode', () => ({
  ...jest.requireActual('../test/__mocks__/vscode'),
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  ThemeIcon: jest.fn().mockImplementation((id: string) => ({ id })),
  TreeItem: jest.fn().mockImplementation((label: string, state: number) => ({ label, collapsibleState: state })),
  EventEmitter: jest.fn().mockImplementation(() => ({
    event: jest.fn(),
    fire: jest.fn(),
    dispose: jest.fn()
  }))
}));

const mockFiles: GitFile[] = [
  {
    absolutePath: '/proj/src/a.php',
    relativePath: 'src/a.php',
    workspaceRoot: '/proj',
    status: 'modified',
    checked: false
  },
  {
    absolutePath: '/proj/src/b.php',
    relativePath: 'src/b.php',
    workspaceRoot: '/proj',
    status: 'added',
    checked: false
  },
  {
    absolutePath: '/proj/draft.php',
    relativePath: 'draft.php',
    workspaceRoot: '/proj',
    status: 'untracked',
    checked: false
  }
];

const mockGroups: WorkspaceGroup[] = [{
  workspaceRoot: '/proj',
  branchName: 'main',
  files: mockFiles
}];

describe('GitPanelProvider', () => {
  let provider: GitPanelProvider;

  beforeEach(() => {
    provider = new GitPanelProvider(mockGroups);
  });

  describe('getChildren', () => {
    it('returns workspace folder nodes at root level', async () => {
      const children = await provider.getChildren(undefined);
      expect(children).toHaveLength(1);
      expect(children[0].label).toContain('proj');
    });

    it('returns section nodes (Changes, Unversioned) under workspace folder', async () => {
      const roots = await provider.getChildren(undefined);
      const sections = await provider.getChildren(roots[0]);
      const labels = sections.map(s => s.label);
      expect(labels).toContain('Changes');
      expect(labels).toContain('Unversioned Files');
    });

    it('returns only tracked changed files under Changes section', async () => {
      const roots = await provider.getChildren(undefined);
      const sections = await provider.getChildren(roots[0]);
      const changesSection = sections.find(s => s.label === 'Changes')!;
      const files = await provider.getChildren(changesSection);
      expect(files).toHaveLength(2); // modified + added, not untracked
      expect(files.every(f => f.file?.status !== 'untracked')).toBe(true);
    });

    it('returns only untracked files under Unversioned Files section', async () => {
      const roots = await provider.getChildren(undefined);
      const sections = await provider.getChildren(roots[0]);
      const unversionedSection = sections.find(s => s.label === 'Unversioned Files')!;
      const files = await provider.getChildren(unversionedSection);
      expect(files).toHaveLength(1);
      expect(files[0].file?.status).toBe('untracked');
    });
  });

  describe('checkbox state', () => {
    it('getCheckedFiles returns empty array initially', () => {
      const checked = provider.getCheckedFiles();
      expect(checked).toHaveLength(0);
    });

    it('setChecked marks a file as checked', () => {
      provider.setChecked('/proj/src/a.php', true);
      const checked = provider.getCheckedFiles();
      expect(checked).toHaveLength(1);
      expect(checked[0].absolutePath).toBe('/proj/src/a.php');
    });

    it('setChecked false unchecks a file', () => {
      provider.setChecked('/proj/src/a.php', true);
      provider.setChecked('/proj/src/a.php', false);
      expect(provider.getCheckedFiles()).toHaveLength(0);
    });

    it('toggleCheck flips checkbox state', () => {
      provider.setChecked('/proj/src/a.php', true);
      provider.toggleCheck('/proj/src/a.php');
      expect(provider.getCheckedFiles()).toHaveLength(0);
    });

    it('toggleCheck checks an unchecked file', () => {
      provider.toggleCheck('/proj/src/a.php');
      expect(provider.getCheckedFiles()).toHaveLength(1);
    });
  });

  describe('refresh', () => {
    it('updates the file groups', () => {
      const newGroups: WorkspaceGroup[] = [{
        workspaceRoot: '/proj',
        branchName: 'dev',
        files: [mockFiles[0]]
      }];
      provider.refresh(newGroups);
      // After refresh with 1 file, only 1 changed file should appear
      // (tested via getChildren indirectly — we just verify no crash)
      expect(() => provider.getCheckedFiles()).not.toThrow();
    });

    it('clears checked state for files no longer present after refresh', () => {
      provider.setChecked('/proj/src/a.php', true);
      provider.setChecked('/proj/src/b.php', true);
      // Refresh with only a.php
      provider.refresh([{
        workspaceRoot: '/proj',
        branchName: 'main',
        files: [mockFiles[0]] // only a.php
      }]);
      const checked = provider.getCheckedFiles();
      expect(checked).toHaveLength(1);
      expect(checked[0].absolutePath).toBe('/proj/src/a.php');
    });
  });
});
