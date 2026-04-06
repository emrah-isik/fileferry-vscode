import * as vscode from 'vscode';
import { StatusBarItem } from '../../../ui/StatusBarItem';
import type { ProjectBindingManager } from '../../../storage/ProjectBindingManager';
import type { ServerManager } from '../../../storage/ServerManager';

const mockBindingManager = {
  getBinding: jest.fn(),
} as unknown as ProjectBindingManager;

const mockServerManager = {
  getServer: jest.fn(),
} as unknown as ServerManager;

const serverFixture = { id: 'srv-1', name: 'Production' };

const bindingFixture = {
  defaultServerId: 'srv-1',
  uploadOnSave: false,
  servers: { 'srv-1': { mappings: [{ localPath: '/', remotePath: '' }], excludedPaths: [] } },
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
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(bindingFixture);
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(serverFixture);
  });

  it('shows $(server) icon when uploadOnSave is off', async () => {
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
    await bar.refresh();

    expect(mockItem.text).toBe('$(server) Production');
  });

  it('shows $(cloud-upload) icon when uploadOnSave is on', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue({ ...bindingFixture, uploadOnSave: true });
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
    await bar.refresh();

    expect(mockItem.text).toBe('$(cloud-upload) Production');
  });

  it('shows $(server) icon when uploadOnSave is undefined', async () => {
    const { uploadOnSave, ...bindingWithout } = bindingFixture;
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(bindingWithout);
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
    await bar.refresh();

    expect(mockItem.text).toBe('$(server) Production');
  });

  it('shows $(server) FileFerry when no binding exists', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(null);
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
    await bar.refresh();

    expect(mockItem.text).toBe('$(server) FileFerry');
  });

  it('shows $(server) FileFerry when server is not found', async () => {
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(null);
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
    await bar.refresh();

    expect(mockItem.text).toBe('$(server) FileFerry');
  });

  it('updates tooltip to indicate upload-on-save status when on', async () => {
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue({ ...bindingFixture, uploadOnSave: true });
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
    await bar.refresh();

    expect(mockItem.tooltip).toContain('Upload on save: ON');
  });

  it('updates tooltip to indicate upload-on-save status when off', async () => {
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
    await bar.refresh();

    expect(mockItem.tooltip).toContain('Upload on save: OFF');
  });

  it('sets command to fileferry.statusBarMenu', () => {
    const ctx = makeContext();
    const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
    expect(mockItem.command).toBe('fileferry.statusBarMenu');
  });

  describe('quick pick menu', () => {
    it('shows quick pick with upload-on-save toggle, switch server, and settings options', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
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
      (mockBindingManager.getBinding as jest.Mock).mockResolvedValue({ ...bindingFixture, uploadOnSave: true });
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
      await bar.refresh();

      await bar.showMenu();

      const items = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
      const toggleItem = items.find((i: any) => i.id === 'toggleUploadOnSave');
      expect(toggleItem.description).toContain('ON');
    });

    it('shows "OFF" indicator when uploadOnSave is false', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
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
      const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
      await bar.refresh();

      await bar.showMenu();

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.toggleUploadOnSave');
    });

    it('executes switchServer command when switch server is selected', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'switchServer' });
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
      await bar.refresh();

      await bar.showMenu();

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.switchServer');
    });

    it('executes openSettings command when settings is selected', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'openSettings' });
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
      await bar.refresh();

      await bar.showMenu();

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.openSettings');
    });

    it('does nothing when quick pick is dismissed', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const ctx = makeContext();
      const bar = new StatusBarItem(ctx, mockBindingManager, mockServerManager);
      await bar.refresh();

      await bar.showMenu();

      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
  });
});
