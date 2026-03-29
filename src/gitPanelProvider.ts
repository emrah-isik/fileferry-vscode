import * as vscode from 'vscode';
import * as path from 'path';
import { GitFile, GitStatus } from './types';

// Maps git status to VSCode built-in icon IDs
const STATUS_ICON_MAP: Record<GitStatus, string> = {
  modified:  'git-commit',
  added:     'diff-added',
  deleted:   'diff-removed',
  renamed:   'diff-renamed',
  untracked: 'question',
  copied:    'files',
};

// A node in the tree can be one of three kinds:
// - 'workspace'  : top-level folder node (e.g. "myproject [main]")
// - 'section'    : "Changes" or "Unversioned Files"
// - 'file'       : individual file with checkbox
export type NodeKind = 'workspace' | 'section' | 'file';

export class FileFerryTreeItem extends vscode.TreeItem {
  kind: NodeKind;
  file?: GitFile;           // only set on file nodes
  sectionType?: 'changes' | 'unversioned'; // only set on section nodes

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    kind: NodeKind
  ) {
    super(label, collapsibleState);
    this.kind = kind;
  }
}

export interface WorkspaceGroup {
  workspaceRoot: string;
  branchName: string;
  files: GitFile[];
}

export class GitPanelProvider implements vscode.TreeDataProvider<FileFerryTreeItem> {
  private groups: WorkspaceGroup[];

  // checkedPaths tracks checkbox state separately from the GitFile objects
  // so it survives refreshes (files are rebuilt from git state on each refresh)
  private checkedPaths = new Set<string>();

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileFerryTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(groups: WorkspaceGroup[]) {
    this.groups = groups;
  }

  // Called by VSCode to render each node into a TreeItem
  getTreeItem(element: FileFerryTreeItem): FileFerryTreeItem {
    return element;
  }

  // Called by VSCode to get child nodes. `element` is undefined for the root level.
  async getChildren(element?: FileFerryTreeItem): Promise<FileFerryTreeItem[]> {
    // Root level — return one workspace folder node per group
    if (!element) {
      return this.groups.map(group => {
        const folderName = path.basename(group.workspaceRoot);
        const item = new FileFerryTreeItem(
          `${folderName} [${group.branchName}]`,
          vscode.TreeItemCollapsibleState.Expanded,
          'workspace'
        );
        item.tooltip = group.workspaceRoot;
        return item;
      });
    }

    // Workspace folder node — return section nodes
    if (element.kind === 'workspace') {
      const folderName = element.label?.toString().replace(/\s\[.*\]$/, '') ?? '';
      const group = this.groups.find(g => path.basename(g.workspaceRoot) === folderName);
      if (!group) { return []; }

      const changedCount = group.files.filter(f => f.status !== 'untracked').length;
      const untrackedCount = group.files.filter(f => f.status === 'untracked').length;

      const sections: FileFerryTreeItem[] = [];

      if (changedCount > 0) {
        const changesNode = new FileFerryTreeItem(
          'Changes',
          vscode.TreeItemCollapsibleState.Expanded,
          'section'
        );
        changesNode.sectionType = 'changes';
        changesNode.description = `${changedCount}`;
        sections.push(changesNode);
      }

      if (untrackedCount > 0) {
        const unversionedNode = new FileFerryTreeItem(
          'Unversioned Files',
          vscode.TreeItemCollapsibleState.Collapsed,
          'section'
        );
        unversionedNode.sectionType = 'unversioned';
        unversionedNode.description = `${untrackedCount}`;
        sections.push(unversionedNode);
      }

      return sections;
    }

    // Section node — return file nodes
    if (element.kind === 'section') {
      const isUnversioned = element.sectionType === 'unversioned';

      // Find which group this section belongs to by looking at the parent label
      // We store all groups' files and filter by section type
      const allFiles = this.groups.flatMap(g => g.files);
      const sectionFiles = isUnversioned
        ? allFiles.filter(f => f.status === 'untracked')
        : allFiles.filter(f => f.status !== 'untracked');

      return sectionFiles.map(file => this.buildFileItem(file));
    }

    return [];
  }

  private buildFileItem(file: GitFile): FileFerryTreeItem {
    const filename = path.basename(file.relativePath);
    const dir = path.dirname(file.relativePath);

    const item = new FileFerryTreeItem(
      filename,
      vscode.TreeItemCollapsibleState.None,
      'file'
    );

    item.file = { ...file, checked: this.checkedPaths.has(file.absolutePath) };
    item.description = dir === '.' ? '' : dir;
    item.iconPath = new vscode.ThemeIcon(STATUS_ICON_MAP[file.status]);
    item.checkboxState = this.checkedPaths.has(file.absolutePath)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    item.command = {
      command: 'fileferry.openFile',
      title: 'Open File',
      arguments: [file]
    };
    item.contextValue = 'fileferryFile';
    item.tooltip = file.relativePath;

    return item;
  }

  // --- Checkbox management ---

  setChecked(absolutePath: string, checked: boolean): void {
    if (checked) {
      this.checkedPaths.add(absolutePath);
    } else {
      this.checkedPaths.delete(absolutePath);
    }
    this._onDidChangeTreeData.fire();
  }

  toggleCheck(absolutePath: string): void {
    this.setChecked(absolutePath, !this.checkedPaths.has(absolutePath));
  }

  getCheckedFiles(): GitFile[] {
    const allFiles = this.groups.flatMap(g => g.files);
    return allFiles
      .filter(f => this.checkedPaths.has(f.absolutePath))
      .map(f => ({ ...f, checked: true }));
  }

  // --- Refresh ---

  // Called when git state changes. Replaces file groups and prunes stale checked paths.
  refresh(newGroups?: WorkspaceGroup[]): void {
    if (newGroups) {
      this.groups = newGroups;

      // Remove checked paths for files that no longer exist in the new state
      const allPaths = new Set(newGroups.flatMap(g => g.files.map(f => f.absolutePath)));
      for (const p of this.checkedPaths) {
        if (!allPaths.has(p)) {
          this.checkedPaths.delete(p);
        }
      }
    }
    this._onDidChangeTreeData.fire();
  }
}
