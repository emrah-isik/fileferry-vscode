import { pickRemoteDirectory } from '../../../commands/pickRemoteDirectory';
import { FileEntry } from '../../../transferService';

const vscode = require('vscode');

const mockConnection = {
  listDirectory: jest.fn(),
  resolveSymlinkTargets: jest.fn(),
};

function entry(name: string, type: 'd' | '-' | 'l'): FileEntry {
  return { name, type, size: 0, modifyTime: 1710000000000 };
}

function labelsOf(quickPickCall: any[]): string[] {
  return quickPickCall[0].map((item: any) => item.label);
}

describe('pickRemoteDirectory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.listDirectory.mockResolvedValue([]);
    mockConnection.resolveSymlinkTargets.mockResolvedValue(new Map());
  });

  it('returns the start path when "Select this folder" is chosen immediately', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    const picked = await pickRemoteDirectory(mockConnection as any, '/var/www', 'Move to');

    expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www');
    expect(picked).toBe('/var/www');
  });

  it('returns undefined when the picker is dismissed', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(undefined);

    const picked = await pickRemoteDirectory(mockConnection as any, '/var/www', 'Move to');

    expect(picked).toBeUndefined();
  });

  it('lists subdirectories as navigable rows and hides plain files', async () => {
    mockConnection.listDirectory.mockResolvedValue([
      entry('assets', 'd'),
      entry('index.php', '-'),
      entry('logs', 'd'),
    ]);
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    await pickRemoteDirectory(mockConnection as any, '/var/www', 'Move to');

    const labels = labelsOf(vscode.window.showQuickPick.mock.calls[0]);
    expect(labels).toContain('$(folder) assets');
    expect(labels).toContain('$(folder) logs');
    expect(labels.join('\n')).not.toContain('index.php');
  });

  it('offers ".." everywhere except the filesystem root', async () => {
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(arrow-up) ..' })  // at /var/www
      .mockResolvedValueOnce({ label: '$(arrow-up) ..' })  // at /var
      .mockResolvedValueOnce({ label: '$(check) Select this folder' }); // at /

    const picked = await pickRemoteDirectory(mockConnection as any, '/var/www', 'Move to');

    expect(picked).toBe('/');
    const rootCallLabels = labelsOf(vscode.window.showQuickPick.mock.calls[2]);
    expect(rootCallLabels.join('\n')).not.toContain('$(arrow-up)');
    const nonRootLabels = labelsOf(vscode.window.showQuickPick.mock.calls[0]);
    expect(nonRootLabels).toContain('$(arrow-up) ..');
  });

  it('navigates into a subdirectory, re-lists it, and returns the deeper path on select', async () => {
    mockConnection.listDirectory.mockResolvedValue([entry('assets', 'd')]);
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(folder) assets' })
      .mockResolvedValueOnce({ label: '$(check) Select this folder' });

    const picked = await pickRemoteDirectory(mockConnection as any, '/var/www', 'Move to');

    expect(mockConnection.listDirectory).toHaveBeenNthCalledWith(1, '/var/www');
    expect(mockConnection.listDirectory).toHaveBeenNthCalledWith(2, '/var/www/assets');
    expect(picked).toBe('/var/www/assets');
  });

  it('does not double the slash when navigating below the root', async () => {
    mockConnection.listDirectory.mockResolvedValue([entry('var', 'd')]);
    vscode.window.showQuickPick
      .mockResolvedValueOnce({ label: '$(folder) var' })
      .mockResolvedValueOnce({ label: '$(check) Select this folder' });

    const picked = await pickRemoteDirectory(mockConnection as any, '/', 'Move to');

    expect(picked).toBe('/var');
  });

  it('shows a symlink to a directory as a navigable folder, but not a symlink to a file', async () => {
    const entries = [entry('current', 'l'), entry('latest.log', 'l')];
    mockConnection.listDirectory.mockResolvedValue(entries);
    mockConnection.resolveSymlinkTargets.mockResolvedValue(
      new Map([['current', 'd'], ['latest.log', '-']])
    );
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    await pickRemoteDirectory(mockConnection as any, '/var/www', 'Move to');

    expect(mockConnection.resolveSymlinkTargets).toHaveBeenCalledWith(entries, '/var/www');
    const labels = labelsOf(vscode.window.showQuickPick.mock.calls[0]);
    expect(labels).toContain('$(folder) current');
    expect(labels.join('\n')).not.toContain('latest.log');
  });

  it('normalizes a trailing slash off the start path', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    const picked = await pickRemoteDirectory(mockConnection as any, '/var/www/', 'Move to');

    expect(mockConnection.listDirectory).toHaveBeenCalledWith('/var/www');
    expect(picked).toBe('/var/www');
  });

  it('shows the title and current path on every step', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(check) Select this folder' });

    await pickRemoteDirectory(mockConnection as any, '/var/www', 'Move to');

    const options = vscode.window.showQuickPick.mock.calls[0][1];
    expect(options.title).toBe('Move to: /var/www');
  });

  it('reports a listing failure and returns undefined', async () => {
    mockConnection.listDirectory.mockRejectedValue(new Error('Permission denied'));

    const picked = await pickRemoteDirectory(mockConnection as any, '/var/www', 'Move to');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Permission denied')
    );
    expect(picked).toBeUndefined();
  });
});
