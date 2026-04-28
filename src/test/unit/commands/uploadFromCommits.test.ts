import * as vscode from 'vscode';

jest.mock('../../../gitService');
jest.mock('../../../commands/uploadSelected');
jest.mock('fs', () => ({
  statSync: jest.fn(),
  existsSync: jest.fn(),
}));

import * as fs from 'fs';
import { GitService } from '../../../gitService';
import { uploadSelected } from '../../../commands/uploadSelected';
import { uploadFromCommits } from '../../../commands/uploadFromCommits';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockGetFilesChangedInCommit = jest.fn();
const mockGetRecentCommits = jest.fn();
(GitService as jest.Mock).mockImplementation(() => ({
  getFilesChangedInCommit: mockGetFilesChangedInCommit,
  getRecentCommits: mockGetRecentCommits,
}));

const mockUploadSelected = uploadSelected as jest.Mock;
const mockStatSync = fs.statSync as unknown as jest.Mock;

const mockCredentialManager = {} as CredentialManager;
const mockConfigManager = {} as ProjectConfigManager;
const mockContext = {} as vscode.ExtensionContext;
const mockOutput = { appendLine: jest.fn(), show: jest.fn() } as unknown as vscode.OutputChannel;

function dependencies() {
  return {
    credentialManager: mockCredentialManager,
    configManager: mockConfigManager,
    context: mockContext,
    output: mockOutput,
  };
}

const fileEntry = (absolutePath: string, status: string = 'modified') => ({
  absolutePath,
  relativePath: absolutePath.replace(/^\/workspace\//, ''),
  workspaceRoot: '/workspace',
  status,
  checked: false,
});

// Shape that VS Code passes to scm/historyItem/context commands
const historyItem = (id: string) => ({ id });

describe('uploadFromCommits command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    mockStatSync.mockImplementation(() => ({ isDirectory: () => false }));
    mockUploadSelected.mockResolvedValue(undefined);
  });

  it('shows warning and aborts when no workspace is open', async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    await uploadFromCommits(historyItem('abc'), undefined, dependencies());
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('workspace')
    );
    expect(mockUploadSelected).not.toHaveBeenCalled();
  });

  it('queries GitService once for a single commit', async () => {
    mockGetFilesChangedInCommit.mockResolvedValue([fileEntry('/workspace/src/app.php')]);
    await uploadFromCommits(historyItem('abc'), undefined, dependencies());
    expect(mockGetFilesChangedInCommit).toHaveBeenCalledTimes(1);
    expect(mockGetFilesChangedInCommit).toHaveBeenCalledWith('/workspace', 'abc');
  });

  it('calls uploadSelected with one resource per touched file', async () => {
    mockGetFilesChangedInCommit.mockResolvedValue([
      fileEntry('/workspace/src/app.php'),
      fileEntry('/workspace/src/util.php'),
    ]);
    await uploadFromCommits(historyItem('abc'), undefined, dependencies());
    expect(mockUploadSelected).toHaveBeenCalledTimes(1);
    const [primary, all] = mockUploadSelected.mock.calls[0];
    expect(all).toHaveLength(2);
    expect(all[0].resourceUri.fsPath).toBe('/workspace/src/app.php');
    expect(all[1].resourceUri.fsPath).toBe('/workspace/src/util.php');
    expect(primary).toBe(all[0]);
  });

  it('unions and dedupes file paths across multiple selected commits', async () => {
    mockGetFilesChangedInCommit.mockImplementation(async (_root: string, sha: string) => {
      if (sha === 'sha1') {
        return [fileEntry('/workspace/src/app.php'), fileEntry('/workspace/src/util.php')];
      }
      if (sha === 'sha2') {
        return [fileEntry('/workspace/src/util.php'), fileEntry('/workspace/src/extra.php')];
      }
      return [];
    });

    await uploadFromCommits(
      historyItem('sha1'),
      [historyItem('sha1'), historyItem('sha2')],
      dependencies()
    );

    expect(mockGetFilesChangedInCommit).toHaveBeenCalledTimes(2);
    const [, all] = mockUploadSelected.mock.calls[0];
    const paths = all.map((r: vscode.SourceControlResourceState) => r.resourceUri.fsPath).sort();
    expect(paths).toEqual([
      '/workspace/src/app.php',
      '/workspace/src/extra.php',
      '/workspace/src/util.php',
    ]);
  });

  it('shows warning and skips upload when the union of touched files is empty', async () => {
    mockGetFilesChangedInCommit.mockResolvedValue([]);
    await uploadFromCommits(historyItem('merge'), undefined, dependencies());
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('no files')
    );
    expect(mockUploadSelected).not.toHaveBeenCalled();
  });

  it('passes deleted files (no longer on disk) through to uploadSelected', async () => {
    mockGetFilesChangedInCommit.mockResolvedValue([
      fileEntry('/workspace/src/deleted.php', 'deleted'),
    ]);
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    await uploadFromCommits(historyItem('abc'), undefined, dependencies());
    const [, all] = mockUploadSelected.mock.calls[0];
    expect(all).toHaveLength(1);
    expect(all[0].resourceUri.fsPath).toBe('/workspace/src/deleted.php');
  });

  it('skips directory entries (submodule guard) and warns once', async () => {
    mockGetFilesChangedInCommit.mockResolvedValue([
      fileEntry('/workspace/src/app.php'),
      fileEntry('/workspace/vendor/lib', 'modified'),
    ]);
    mockStatSync.mockImplementation((p: string) => ({
      isDirectory: () => p === '/workspace/vendor/lib',
    }));
    await uploadFromCommits(historyItem('abc'), undefined, dependencies());
    const [, all] = mockUploadSelected.mock.calls[0];
    expect(all).toHaveLength(1);
    expect(all[0].resourceUri.fsPath).toBe('/workspace/src/app.php');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('submodule')
    );
  });

  it('uses post-rename path for renamed files (forwarded as-is from GitService)', async () => {
    mockGetFilesChangedInCommit.mockResolvedValue([
      fileEntry('/workspace/src/new-name.php', 'renamed'),
    ]);
    await uploadFromCommits(historyItem('abc'), undefined, dependencies());
    const [, all] = mockUploadSelected.mock.calls[0];
    expect(all).toHaveLength(1);
    expect(all[0].resourceUri.fsPath).toBe('/workspace/src/new-name.php');
  });

  it('passes the dependencies object through to uploadSelected', async () => {
    mockGetFilesChangedInCommit.mockResolvedValue([fileEntry('/workspace/src/app.php')]);
    const deps = dependencies();
    await uploadFromCommits(historyItem('abc'), undefined, deps);
    expect(mockUploadSelected).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      deps
    );
  });

  it('accepts an array as the first argument (some VS Code menu shapes pass [items])', async () => {
    mockGetFilesChangedInCommit.mockResolvedValue([fileEntry('/workspace/src/app.php')]);
    await uploadFromCommits(
      [historyItem('sha1'), historyItem('sha2')],
      undefined,
      dependencies()
    );
    expect(mockGetFilesChangedInCommit).toHaveBeenCalledTimes(2);
  });

  describe('QuickPick fallback (Command Palette entry point)', () => {
    const recentCommits = [
      { sha: 'aaa1111', subject: 'Latest change', author: 'Alice', timestamp: 1700000300 },
      { sha: 'bbb2222', subject: 'Earlier change', author: 'Bob', timestamp: 1700000200 },
      { sha: 'ccc3333', subject: 'Oldest change', author: 'Carol', timestamp: 1700000100 },
    ];

    beforeEach(() => {
      mockGetRecentCommits.mockResolvedValue(recentCommits);
    });

    it('shows a multi-select QuickPick of recent commits when invoked with no args', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      await uploadFromCommits(undefined, undefined, dependencies());
      expect(mockGetRecentCommits).toHaveBeenCalledWith('/workspace', expect.any(Number));
      const quickPickArgs = (vscode.window.showQuickPick as jest.Mock).mock.calls[0];
      expect(quickPickArgs[1]).toEqual(
        expect.objectContaining({ canPickMany: true })
      );
    });

    it('aborts silently when the user dismisses the QuickPick', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      await uploadFromCommits(undefined, undefined, dependencies());
      expect(mockGetFilesChangedInCommit).not.toHaveBeenCalled();
      expect(mockUploadSelected).not.toHaveBeenCalled();
    });

    it('proceeds with the SHA(s) the user picks from the QuickPick', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue([
        { sha: 'aaa1111' },
        { sha: 'ccc3333' },
      ]);
      mockGetFilesChangedInCommit.mockImplementation(async (_root: string, sha: string) => {
        return [fileEntry(`/workspace/src/${sha}.php`)];
      });
      await uploadFromCommits(undefined, undefined, dependencies());
      expect(mockGetFilesChangedInCommit).toHaveBeenCalledTimes(2);
      const calledShas = mockGetFilesChangedInCommit.mock.calls.map(c => c[1]);
      expect(calledShas).toEqual(['aaa1111', 'ccc3333']);
      expect(mockUploadSelected).toHaveBeenCalledTimes(1);
    });

    it('shows warning when there are no commits to pick from', async () => {
      mockGetRecentCommits.mockResolvedValue([]);
      await uploadFromCommits(undefined, undefined, dependencies());
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('commit')
      );
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(mockUploadSelected).not.toHaveBeenCalled();
    });
  });
});
