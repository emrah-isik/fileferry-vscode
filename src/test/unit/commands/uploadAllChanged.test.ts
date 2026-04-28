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
import { uploadAllChanged } from '../../../commands/uploadAllChanged';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockGetChangedFiles = jest.fn();
(GitService as jest.Mock).mockImplementation(() => ({ getChangedFiles: mockGetChangedFiles }));

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

describe('uploadAllChanged command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    mockStatSync.mockImplementation(() => ({ isDirectory: () => false }));
    mockUploadSelected.mockResolvedValue(undefined);
  });

  it('shows warning and aborts when no workspace is open', async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    await uploadAllChanged(dependencies());
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('workspace')
    );
    expect(mockUploadSelected).not.toHaveBeenCalled();
  });

  it('queries GitService with the active workspace root', async () => {
    mockGetChangedFiles.mockReturnValue([fileEntry('/workspace/src/app.php')]);
    await uploadAllChanged(dependencies());
    expect(mockGetChangedFiles).toHaveBeenCalledWith('/workspace');
  });

  it('shows warning and skips upload when no changed files exist', async () => {
    mockGetChangedFiles.mockReturnValue([]);
    await uploadAllChanged(dependencies());
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No changed files')
    );
    expect(mockUploadSelected).not.toHaveBeenCalled();
  });

  it('calls uploadSelected with one resource per changed file', async () => {
    mockGetChangedFiles.mockReturnValue([
      fileEntry('/workspace/src/app.php'),
      fileEntry('/workspace/src/util.php'),
    ]);
    await uploadAllChanged(dependencies());
    expect(mockUploadSelected).toHaveBeenCalledTimes(1);
    const [primary, all] = mockUploadSelected.mock.calls[0];
    expect(all).toHaveLength(2);
    expect(all[0].resourceUri.fsPath).toBe('/workspace/src/app.php');
    expect(all[1].resourceUri.fsPath).toBe('/workspace/src/util.php');
    expect(primary).toBe(all[0]);
  });

  it('passes the dependencies object through to uploadSelected', async () => {
    mockGetChangedFiles.mockReturnValue([fileEntry('/workspace/src/app.php')]);
    const deps = dependencies();
    await uploadAllChanged(deps);
    expect(mockUploadSelected).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      deps
    );
  });

  it('forwards deleted files (no longer on disk) to uploadSelected unchanged', async () => {
    mockGetChangedFiles.mockReturnValue([
      fileEntry('/workspace/src/deleted.php', 'deleted'),
    ]);
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    await uploadAllChanged(dependencies());
    const [, all] = mockUploadSelected.mock.calls[0];
    expect(all).toHaveLength(1);
    expect(all[0].resourceUri.fsPath).toBe('/workspace/src/deleted.php');
  });

  it('skips directory entries (submodule guard) and warns once', async () => {
    mockGetChangedFiles.mockReturnValue([
      fileEntry('/workspace/src/app.php'),
      fileEntry('/workspace/vendor/lib', 'modified'),
    ]);
    mockStatSync.mockImplementation((p: string) => ({
      isDirectory: () => p === '/workspace/vendor/lib',
    }));
    await uploadAllChanged(dependencies());
    const [, all] = mockUploadSelected.mock.calls[0];
    expect(all).toHaveLength(1);
    expect(all[0].resourceUri.fsPath).toBe('/workspace/src/app.php');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('submodule')
    );
  });

  it('shows warning and skips upload when only directory entries exist after guard', async () => {
    mockGetChangedFiles.mockReturnValue([
      fileEntry('/workspace/vendor/lib', 'modified'),
    ]);
    mockStatSync.mockImplementation(() => ({ isDirectory: () => true }));
    await uploadAllChanged(dependencies());
    expect(mockUploadSelected).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});
