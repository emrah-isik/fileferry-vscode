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

import * as vscode from 'vscode';
const mockGetAPI = (vscode.extensions.getExtension('vscode.git') as any).exports.getAPI as jest.Mock;

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
