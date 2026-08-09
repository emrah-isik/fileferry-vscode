import * as path from 'path';

jest.mock('fs');

import * as fs from 'fs';
import { pickLocalDirectory, pickLocalFiles } from '../../../commands/pickLocalDirectory';

const vscode = require('vscode');

const mockReaddirSync = fs.readdirSync as jest.Mock;
const mockStatSync = fs.statSync as jest.Mock;

function dirent(name: string, kind: 'directory' | 'file' | 'symlink') {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function labelsOf(quickPickCall: any[]): string[] {
  return quickPickCall[0].map((item: any) => item.label);
}

const START = path.join('/home/emo', 'projects');

describe('pickLocalDirectory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReaddirSync.mockReturnValue([]);
    mockStatSync.mockReturnValue({ isDirectory: () => false });
  });

  it('returns the start path when "Select this folder" is chosen immediately', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    const picked = await pickLocalDirectory(START, 'Upload a folder to /var/www');

    expect(mockReaddirSync).toHaveBeenCalledWith(START, { withFileTypes: true });
    expect(picked).toBe(START);
  });

  it('returns undefined when the picker is dismissed', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(undefined);

    const picked = await pickLocalDirectory(START, 'Upload a folder to /var/www');

    expect(picked).toBeUndefined();
  });

  it('lists subdirectories as navigable rows and hides plain files', async () => {
    mockReaddirSync.mockReturnValue([
      dirent('assets', 'directory'),
      dirent('index.php', 'file'),
      dirent('logs', 'directory'),
    ]);
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    await pickLocalDirectory(START, 'Upload a folder to /var/www');

    const labels = labelsOf(vscode.window.showQuickPick.mock.calls[0]);
    expect(labels).toContain('$(folder) assets');
    expect(labels).toContain('$(folder) logs');
    expect(labels.join('\n')).not.toContain('index.php');
  });

  it('navigates into a subdirectory and returns the deeper path on select', async () => {
    mockReaddirSync.mockReturnValue([dirent('assets', 'directory')]);
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(folder) assets' })
      .mockResolvedValueOnce({ label: '$(check) Select this folder' });

    const picked = await pickLocalDirectory(START, 'Upload a folder to /var/www');

    expect(mockReaddirSync).toHaveBeenNthCalledWith(2, path.join(START, 'assets'), { withFileTypes: true });
    expect(picked).toBe(path.join(START, 'assets'));
  });

  it('offers ".." everywhere except the filesystem root', async () => {
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(arrow-up) ..' })   // at /home/emo/projects
      .mockResolvedValueOnce({ label: '$(arrow-up) ..' })   // at /home/emo
      .mockResolvedValueOnce({ label: '$(arrow-up) ..' })   // at /home
      .mockResolvedValueOnce({ label: '$(check) Select this folder' }); // at the root

    const picked = await pickLocalDirectory(START, 'Upload a folder to /var/www');

    expect(picked).toBe(path.parse(START).root);
    const rootCallLabels = labelsOf(vscode.window.showQuickPick.mock.calls[3]);
    expect(rootCallLabels.join('\n')).not.toContain('$(arrow-up)');
    const nonRootLabels = labelsOf(vscode.window.showQuickPick.mock.calls[0]);
    expect(nonRootLabels).toContain('$(arrow-up) ..');
  });

  it('shows a symlink to a directory as navigable, but not a symlink to a file', async () => {
    mockReaddirSync.mockReturnValue([
      dirent('current', 'symlink'),
      dirent('latest.log', 'symlink'),
    ]);
    mockStatSync.mockImplementation((target: string) => ({
      isDirectory: () => target === path.join(START, 'current'),
    }));
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    await pickLocalDirectory(START, 'Upload a folder to /var/www');

    const labels = labelsOf(vscode.window.showQuickPick.mock.calls[0]);
    expect(labels).toContain('$(folder) current');
    expect(labels.join('\n')).not.toContain('latest.log');
  });

  it('tolerates a broken symlink (stat throws) by hiding it', async () => {
    mockReaddirSync.mockReturnValue([dirent('dangling', 'symlink')]);
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    const picked = await pickLocalDirectory(START, 'Upload a folder to /var/www');

    expect(picked).toBe(START);
    const labels = labelsOf(vscode.window.showQuickPick.mock.calls[0]);
    expect(labels.join('\n')).not.toContain('dangling');
  });

  it('shows the title and current path on every step', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    await pickLocalDirectory(START, 'Upload a folder to /var/www');

    const options = vscode.window.showQuickPick.mock.calls[0][1];
    expect(options.title).toBe(`Upload a folder to /var/www: ${START}`);
  });

  it('reports a listing failure and returns undefined', async () => {
    mockReaddirSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    const picked = await pickLocalDirectory(START, 'Upload a folder to /var/www');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('permission denied')
    );
    expect(picked).toBeUndefined();
  });
});

// Two-step multi-file pick for remote windows (feature-33 manual pass, finding
// U1): VS Code's simple file dialog ignores canSelectMany, so files are picked
// by navigating to a folder (pickLocalDirectory loop) and then multi-selecting
// from a checkbox QuickPick of that folder's files.
describe('pickLocalFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReaddirSync.mockReturnValue([
      dirent('a.txt', 'file'),
      dirent('b.txt', 'file'),
      dirent('assets', 'directory'),
    ]);
    mockStatSync.mockReturnValue({ isDirectory: () => false, isFile: () => false });
  });

  it('navigates to a folder, then multi-selects from its FILES only', async () => {
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(check) Choose files from this folder' }) // folder stage
      .mockResolvedValueOnce([{ label: 'a.txt' }, { label: 'b.txt' }]);           // file stage

    const picked = await pickLocalFiles(START, 'Upload files to /var/www');

    const fileStageCall = vscode.window.showQuickPick.mock.calls[1];
    expect(fileStageCall[1].canPickMany).toBe(true);
    const labels = fileStageCall[0].map((item: any) => item.label);
    expect(labels).toEqual(['a.txt', 'b.txt']);
    expect(labels.join('\n')).not.toContain('assets');
    expect(picked).toEqual([path.join(START, 'a.txt'), path.join(START, 'b.txt')]);
  });

  it('announces both steps: step-aware titles and a confirm row that says files come next', async () => {
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(check) Choose files from this folder' })
      .mockResolvedValueOnce([{ label: 'a.txt' }]);

    await pickLocalFiles(START, 'Upload files to /var/www');

    const folderStage = vscode.window.showQuickPick.mock.calls[0];
    // The confirm row must NOT read "Select this folder" — in the files flow
    // that suggests uploading the folder itself (which is the other command).
    expect(folderStage[0][0].label).toBe('$(check) Choose files from this folder');
    expect(folderStage[1].title).toContain('step 1 of 2');
    const fileStage = vscode.window.showQuickPick.mock.calls[1];
    expect(fileStage[1].title).toContain('step 2 of 2');
  });

  it('returns undefined when the folder stage is dismissed, without a file stage', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(undefined);

    const picked = await pickLocalFiles(START, 'Upload files to /var/www');

    expect(picked).toBeUndefined();
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the file stage is dismissed or empty', async () => {
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(check) Select this folder' })
      .mockResolvedValueOnce([]);

    const picked = await pickLocalFiles(START, 'Upload files to /var/www');

    expect(picked).toBeUndefined();
  });

  it('reports a folder with no files instead of showing an empty checkbox list', async () => {
    mockReaddirSync.mockReturnValue([dirent('assets', 'directory')]);
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    const picked = await pickLocalFiles(START, 'Upload files to /var/www');

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('no files')
    );
    expect(picked).toBeUndefined();
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it('includes a symlink that resolves to a file, hides one that does not', async () => {
    mockReaddirSync.mockReturnValue([
      dirent('a.txt', 'file'),
      dirent('link-to-file', 'symlink'),
      dirent('link-to-dir', 'symlink'),
    ]);
    mockStatSync.mockImplementation((target: string) => ({
      isDirectory: () => target === path.join(START, 'link-to-dir'),
      isFile: () => target === path.join(START, 'link-to-file'),
    }));
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(check) Select this folder' })
      .mockResolvedValueOnce([{ label: 'link-to-file' }]);

    const picked = await pickLocalFiles(START, 'Upload files to /var/www');

    const labels = vscode.window.showQuickPick.mock.calls[1][0].map((item: any) => item.label);
    expect(labels).toContain('link-to-file');
    expect(labels.join('\n')).not.toContain('link-to-dir');
    expect(picked).toEqual([path.join(START, 'link-to-file')]);
  });
});
