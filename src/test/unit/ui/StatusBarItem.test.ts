import * as vscode from 'vscode';
import { StatusBarItem } from '../../../ui/StatusBarItem';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
} as unknown as ProjectConfigManager;

const serverFixture = {
  id: 'srv-1', type: 'sftp',
  credentialId: 'cred-1', credentialName: 'deploy@prod',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: '' }],
  excludedPaths: [],
};

const configFixture = {
  defaultServerId: 'srv-1',
  uploadOnSave: false,
  servers: { Production: serverFixture },
};

let mockItem: any;
let saveListeners: Array<(doc: any) => void>;

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: { get: jest.fn(), update: jest.fn() },
  } as unknown as vscode.ExtensionContext;
}

describe('StatusBarItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveListeners = [];
    mockItem = {
      text: '', tooltip: '', command: '',
      show: jest.fn(), hide: jest.fn(), dispose: jest.fn(),
    };
    (vscode.window.createStatusBarItem as jest.Mock).mockReturnValue(mockItem);
    (vscode.workspace.onDidSaveTextDocument as jest.Mock).mockImplementation((cb: any) => {
      saveListeners.push(cb);
      return { dispose: jest.fn() };
    });
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configFixture);
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue({ name: 'Production', server: serverFixture });
  });

  it('shows $(server) icon when uploadOnSave is off', async () => {
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockConfigManager);
    await bar.refresh();
    expect(mockItem.text).toBe('$(server) Production');
  });

  it('shows $(cloud-upload) icon when uploadOnSave is on', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, uploadOnSave: true });
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockConfigManager);
    await bar.refresh();
    expect(mockItem.text).toBe('$(cloud-upload) Production');
  });

  it('shows $(server) icon when uploadOnSave is undefined', async () => {
    const { uploadOnSave, ...configWithout } = configFixture;
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configWithout);
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockConfigManager);
    await bar.refresh();
    expect(mockItem.text).toBe('$(server) Production');
  });

  it('shows $(server) FileFerry when no config exists', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(null);
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockConfigManager);
    await bar.refresh();
    expect(mockItem.text).toBe('$(server) FileFerry');
  });

  it('shows $(server) FileFerry when server is not found', async () => {
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue(undefined);
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockConfigManager);
    await bar.refresh();
    expect(mockItem.text).toBe('$(server) FileFerry');
  });

  it('updates tooltip to indicate upload-on-save status when on', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, uploadOnSave: true });
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockConfigManager);
    await bar.refresh();
    expect(mockItem.tooltip).toContain('Upload on save: ON');
  });

  it('updates tooltip to indicate upload-on-save status when off', async () => {
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockConfigManager);
    await bar.refresh();
    expect(mockItem.tooltip).toContain('Upload on save: OFF');
  });

  it('sets command to fileferry.statusBarMenu', () => {
    const ctx = makeContext();
    new StatusBarItem(ctx, mockConfigManager);
    expect(mockItem.command).toBe('fileferry.statusBarMenu');
  });

  describe('quick pick menu', () => {
    it('shows quick pick with upload-on-save toggle, switch server, and settings options', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockConfigManager);
      await bar.refresh();
      await bar.showMenu();
      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ label: expect.stringContaining('Upload on Save') }),
          expect.objectContaining({ label: expect.stringContaining('Switch Server') }),
          expect.objectContaining({ label: expect.stringContaining('Deployment Settings') }),
        ]),
        expect.any(Object),
      );
    });

    it('shows "ON" indicator when uploadOnSave is true', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, uploadOnSave: true });
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockConfigManager);
      await bar.refresh();
      await bar.showMenu();
      const items = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
      const toggleItem = items.find((i: any) => i.id === 'toggleUploadOnSave');
      expect(toggleItem.description).toContain('ON');
    });

    it('shows "OFF" indicator when uploadOnSave is false', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockConfigManager);
      await bar.refresh();
      await bar.showMenu();
      const items = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
      const toggleItem = items.find((i: any) => i.id === 'toggleUploadOnSave');
      expect(toggleItem.description).toContain('OFF');
    });

    it('executes toggleUploadOnSave command when toggle is selected', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'toggleUploadOnSave' });
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockConfigManager);
      await bar.refresh();
      await bar.showMenu();
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.toggleUploadOnSave');
    });

    it('executes switchServer command when switch server is selected', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'switchServer' });
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockConfigManager);
      await bar.refresh();
      await bar.showMenu();
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.switchServer');
    });

    it('executes openSettings command when settings is selected', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'openSettings' });
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockConfigManager);
      await bar.refresh();
      await bar.showMenu();
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.openSettings');
    });

    it('does nothing when quick pick is dismissed', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockConfigManager);
      await bar.refresh();
      await bar.showMenu();
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
  });
});
