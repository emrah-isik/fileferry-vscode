import { GitService } from '../gitService';

jest.mock('vscode', () => ({
  ...jest.requireActual('../test/__mocks__/vscode'),
  extensions: {
    getExtension: jest.fn().mockReturnValue({
      exports: { getAPI: jest.fn() },
      isActive: true
    })
  }
}));

jest.mock('child_process');

import * as vscode from 'vscode';
import * as child_process from 'child_process';
const mockGetAPI = (vscode.extensions.getExtension('vscode.git') as any).exports.getAPI as jest.Mock;
const mockExecFile = child_process.execFile as unknown as jest.Mock;

const mockGitAPI = {
  repositories: [{
    rootUri: { fsPath: '/home/user/project' },
    state: {
      HEAD: { name: 'feature/my-branch', commit: 'abc123' },
      workingTreeChanges: [
        { uri: { fsPath: '/home/user/project/src/index.php' }, status: 5 }, // MODIFIED
      ],
      indexChanges: [
        { uri: { fsPath: '/home/user/project/src/new.php' }, status: 1 }   // INDEX_ADDED
      ],
      untrackedChanges: [
        { uri: { fsPath: '/home/user/project/src/draft.php' } }
      ]
    }
  }]
};

describe('GitService', () => {
  let service: GitService;

  beforeEach(() => {
    mockGetAPI.mockReturnValue(mockGitAPI);
    service = new GitService();
  });

  it('returns repositories from git extension', () => {
    const repos = service.getRepositories();
    expect(repos).toHaveLength(1);
    expect(repos[0].rootUri.fsPath).toBe('/home/user/project');
  });

  it('maps git status code 5 (MODIFIED) to "modified"', () => {
    const files = service.getChangedFiles('/home/user/project');
    const modified = files.find(f => f.relativePath === 'src/index.php');
    expect(modified?.status).toBe('modified');
  });

  it('maps git status code 1 (INDEX_ADDED) to "added"', () => {
    const files = service.getChangedFiles('/home/user/project');
    const added = files.find(f => f.relativePath === 'src/new.php');
    expect(added?.status).toBe('added');
  });

  it('includes untracked files with status "untracked"', () => {
    const files = service.getChangedFiles('/home/user/project');
    const untracked = files.find(f => f.relativePath === 'src/draft.php');
    expect(untracked?.status).toBe('untracked');
  });

  it('all files start unchecked', () => {
    const files = service.getChangedFiles('/home/user/project');
    expect(files.every(f => f.checked === false)).toBe(true);
  });

  it('sets correct absolutePath on each file', () => {
    const files = service.getChangedFiles('/home/user/project');
    const modified = files.find(f => f.relativePath === 'src/index.php');
    expect(modified?.absolutePath).toBe('/home/user/project/src/index.php');
  });

  it('returns current branch name', () => {
    const branch = service.getBranchName('/home/user/project');
    expect(branch).toBe('feature/my-branch');
  });

  it('returns "unknown" branch when HEAD is null', () => {
    mockGetAPI.mockReturnValue({
      repositories: [{
        rootUri: { fsPath: '/home/user/project' },
        state: { HEAD: null, workingTreeChanges: [], indexChanges: [], untrackedChanges: [] }
      }]
    });
    service = new GitService();
    const branch = service.getBranchName('/home/user/project');
    expect(branch).toBe('unknown');
  });

  it('returns null when git extension is not available', () => {
    const vscode = require('vscode');
    vscode.extensions.getExtension.mockReturnValueOnce(undefined);
    service = new GitService();
    const repos = service.getRepositories();
    expect(repos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFilesChangedInCommit
// ---------------------------------------------------------------------------

type ExecError = (Error & { code?: number | string }) | null;
type ExecResponder = (
  args: string[]
) => { error: ExecError; stdout: string; stderr?: string };

function setExecResponder(responder: ExecResponder): void {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: any, cb: Function) => {
      const { error, stdout, stderr } = responder(args);
      cb(error, stdout, stderr ?? '');
    }
  );
}

describe('GitService.getFilesChangedInCommit', () => {
  let service: GitService;
  const workspaceRoot = '/home/user/project';

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAPI.mockReturnValue({ repositories: [] });
    service = new GitService();
  });

  it('returns parsed adds, modifies, and deletes for a normal commit', async () => {
    setExecResponder((args) => {
      if (args[0] === 'rev-parse') {
        // <sha>^ resolves — has a parent
        return { error: null, stdout: 'parentsha\n' };
      }
      if (args[0] === 'diff-tree') {
        return {
          error: null,
          stdout: 'M\tsrc/app.ts\nA\tsrc/new.ts\nD\tsrc/old.ts\n',
        };
      }
      return { error: new Error('unexpected git call'), stdout: '' };
    });

    const files = await service.getFilesChangedInCommit(workspaceRoot, 'abc123');

    expect(files).toHaveLength(3);
    expect(files.find(f => f.relativePath === 'src/app.ts')?.status).toBe('modified');
    expect(files.find(f => f.relativePath === 'src/new.ts')?.status).toBe('added');
    expect(files.find(f => f.relativePath === 'src/old.ts')?.status).toBe('deleted');
  });

  it('builds absolute paths under the workspace root', async () => {
    setExecResponder((args) => {
      if (args[0] === 'rev-parse') { return { error: null, stdout: 'parent\n' }; }
      return { error: null, stdout: 'M\tsrc/app.ts\n' };
    });

    const files = await service.getFilesChangedInCommit(workspaceRoot, 'abc');
    expect(files[0].absolutePath).toBe('/home/user/project/src/app.ts');
    expect(files[0].workspaceRoot).toBe(workspaceRoot);
  });

  it('returns post-rename path for renamed files', async () => {
    setExecResponder((args) => {
      if (args[0] === 'rev-parse') { return { error: null, stdout: 'parent\n' }; }
      return {
        error: null,
        stdout: 'R100\tsrc/old-name.ts\tsrc/new-name.ts\n',
      };
    });

    const files = await service.getFilesChangedInCommit(workspaceRoot, 'abc');
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('src/new-name.ts');
    expect(files[0].status).toBe('renamed');
  });

  it('returns destination path for copied files', async () => {
    setExecResponder((args) => {
      if (args[0] === 'rev-parse') { return { error: null, stdout: 'parent\n' }; }
      return {
        error: null,
        stdout: 'C75\tsrc/source.ts\tsrc/dest.ts\n',
      };
    });

    const files = await service.getFilesChangedInCommit(workspaceRoot, 'abc');
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('src/dest.ts');
    expect(files[0].status).toBe('copied');
  });

  it('falls back to git show for root commits (no parent)', async () => {
    setExecResponder((args) => {
      if (args[0] === 'rev-parse') {
        // <sha>^ does not resolve — root commit
        const err = Object.assign(new Error('unknown revision'), { code: 128 });
        return { error: err, stdout: '' };
      }
      if (args[0] === 'show') {
        return {
          error: null,
          stdout: 'A\tREADME.md\nA\tsrc/index.ts\n',
        };
      }
      return { error: new Error('unexpected'), stdout: '' };
    });

    const files = await service.getFilesChangedInCommit(workspaceRoot, 'rootcommit');
    expect(files).toHaveLength(2);
    expect(files.map(f => f.relativePath).sort()).toEqual(['README.md', 'src/index.ts']);
    expect(files.every(f => f.status === 'added')).toBe(true);

    // Verify diff-tree was NOT called for a root commit
    const calls = mockExecFile.mock.calls.map(c => c[1][0]);
    expect(calls).not.toContain('diff-tree');
    expect(calls).toContain('show');
  });

  it('returns empty list for a merge commit (diff-tree default behavior)', async () => {
    setExecResponder((args) => {
      if (args[0] === 'rev-parse') { return { error: null, stdout: 'parent\n' }; }
      if (args[0] === 'diff-tree') { return { error: null, stdout: '' }; }
      return { error: new Error('unexpected'), stdout: '' };
    });

    const files = await service.getFilesChangedInCommit(workspaceRoot, 'merge');
    expect(files).toEqual([]);
  });

  it('returns empty list when git fails (unknown SHA)', async () => {
    setExecResponder(() => {
      const err = Object.assign(new Error('bad object'), { code: 128 });
      return { error: err, stdout: '', stderr: 'fatal: bad object\n' };
    });

    const files = await service.getFilesChangedInCommit(workspaceRoot, 'badsha');
    expect(files).toEqual([]);
  });

  it('dedupes by absolute path when the same path appears twice', async () => {
    setExecResponder((args) => {
      if (args[0] === 'rev-parse') { return { error: null, stdout: 'parent\n' }; }
      return {
        error: null,
        stdout: 'M\tsrc/app.ts\nM\tsrc/app.ts\n',
      };
    });

    const files = await service.getFilesChangedInCommit(workspaceRoot, 'abc');
    expect(files).toHaveLength(1);
  });

  it('runs git from the workspace root', async () => {
    setExecResponder((args) => {
      if (args[0] === 'rev-parse') { return { error: null, stdout: 'parent\n' }; }
      return { error: null, stdout: 'M\tfoo.ts\n' };
    });

    await service.getFilesChangedInCommit(workspaceRoot, 'abc');
    for (const call of mockExecFile.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ cwd: workspaceRoot }));
    }
  });
});

// ---------------------------------------------------------------------------
// getRecentCommits
// ---------------------------------------------------------------------------

describe('GitService.getRecentCommits', () => {
  let service: GitService;
  const workspaceRoot = '/home/user/project';

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAPI.mockReturnValue({ repositories: [] });
    service = new GitService();
  });

  it('parses sha, subject, author, and timestamp from git log', async () => {
    const FS = String.fromCharCode(0x1f);
    const RS = String.fromCharCode(0x1e);
    setExecResponder(() => ({
      error: null,
      stdout:
        ['abc1234', 'Fix bug in foo', 'Alice', '1700000000'].join(FS) + RS +
        ['def5678', 'Add feature', 'Bob', '1699990000'].join(FS) + RS,
    }));

    const commits = await service.getRecentCommits(workspaceRoot, 50);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: 'abc1234',
      subject: 'Fix bug in foo',
      author: 'Alice',
      timestamp: 1700000000,
    });
    expect(commits[1]).toEqual({
      sha: 'def5678',
      subject: 'Add feature',
      author: 'Bob',
      timestamp: 1699990000,
    });
  });

  it('survives subjects that contain pipes, colons, and tabs', async () => {
    const FS = String.fromCharCode(0x1f);
    const RS = String.fromCharCode(0x1e);
    setExecResponder(() => ({
      error: null,
      stdout: ['abc', 'feat: add A | rename B\tC', 'Alice', '1700000000'].join(FS) + RS,
    }));
    const commits = await service.getRecentCommits(workspaceRoot, 50);
    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe('feat: add A | rename B\tC');
  });

  it('passes -n <limit> and the correct format to git log', async () => {
    setExecResponder(() => ({ error: null, stdout: '' }));
    await service.getRecentCommits(workspaceRoot, 25);
    const call = mockExecFile.mock.calls[0];
    const args: string[] = call[1];
    expect(args[0]).toBe('log');
    expect(args).toContain('-n');
    expect(args).toContain('25');
  });

  it('returns empty list when git log fails', async () => {
    setExecResponder(() => ({
      error: Object.assign(new Error('not a git repo'), { code: 128 }),
      stdout: '',
      stderr: 'fatal: not a git repository\n',
    }));
    const commits = await service.getRecentCommits(workspaceRoot, 10);
    expect(commits).toEqual([]);
  });

  it('returns empty list when there are no commits', async () => {
    setExecResponder(() => ({ error: null, stdout: '' }));
    const commits = await service.getRecentCommits(workspaceRoot, 10);
    expect(commits).toEqual([]);
  });

  it('runs git from the workspace root', async () => {
    setExecResponder(() => ({ error: null, stdout: '' }));
    await service.getRecentCommits(workspaceRoot, 10);
    expect(mockExecFile.mock.calls[0][2]).toEqual(
      expect.objectContaining({ cwd: workspaceRoot })
    );
  });
});
