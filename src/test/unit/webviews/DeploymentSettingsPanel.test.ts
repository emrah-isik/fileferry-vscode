import * as vscode from 'vscode';
import { DeploymentSettingsPanel } from '../../../ui/webviews/DeploymentSettingsPanel';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ServerManager } from '../../../storage/ServerManager';
import type { ProjectBindingManager } from '../../../storage/ProjectBindingManager';

jest.mock('../../../sftpService');

import { SftpService } from '../../../sftpService';

// --- Webview + panel mock setup ---
let messageHandler: (msg: any) => void | Promise<void>;

const mockWebview = {
  postMessage: jest.fn(),
  onDidReceiveMessage: jest.fn((handler: any) => {
    messageHandler = handler;
    return { dispose: jest.fn() };
  }),
  asWebviewUri: jest.fn((uri: any) => ({ toString: () => `webview://${uri.fsPath}` })),
  cspSource: 'vscode-resource:',
  html: '',
};

const mockPanel = {
  webview: mockWebview,
  reveal: jest.fn(),
  onDidDispose: jest.fn((_handler: any) => {
    return { dispose: jest.fn() };
  }),
  dispose: jest.fn(),
};

(vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);

// --- Context mock ---
const mockContext = {
  extensionUri: { fsPath: '/ext' },
  subscriptions: [],
} as unknown as vscode.ExtensionContext;

// --- Manager mocks ---
const credentialsMock = [{ id: 'cred-1', name: 'Prod SSH', host: 'example.com', port: 22, username: 'deploy', authMethod: 'password' }];
const serversMock = [{ id: 'srv-1', name: 'Production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' }];
const bindingMock = {
  defaultServerId: 'srv-1',
  servers: {
    'srv-1': { mappings: [{ localPath: '/', remotePath: '/var/www' }], excludedPaths: ['node_modules'] }
  }
};

const mockCredentialManager = {
  getAll: jest.fn().mockResolvedValue(credentialsMock),
  getWithSecret: jest.fn().mockResolvedValue({ ...credentialsMock[0], password: 'secret' }),
} as unknown as CredentialManager;

const mockServerManager = {
  getAll: jest.fn().mockResolvedValue(serversMock),
  save: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
  getServer: jest.fn().mockResolvedValue(serversMock[0]),
} as unknown as ServerManager;

const mockBindingManager = {
  getBinding: jest.fn().mockResolvedValue(bindingMock),
  setDefaultServer: jest.fn().mockResolvedValue(undefined),
  setServerBinding: jest.fn().mockResolvedValue(undefined),
} as unknown as ProjectBindingManager;

function deps() {
  return { credentialManager: mockCredentialManager, serverManager: mockServerManager, bindingManager: mockBindingManager };
}

describe('DeploymentSettingsPanel message handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);
    (mockServerManager.save as jest.Mock).mockResolvedValue(undefined);
    (mockServerManager.delete as jest.Mock).mockResolvedValue(undefined);
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue(credentialsMock);
    (mockServerManager.getAll as jest.Mock).mockResolvedValue(serversMock);
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(bindingMock);
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(serversMock[0]);
    (mockCredentialManager.getWithSecret as jest.Mock).mockResolvedValue({ ...credentialsMock[0], password: 'secret' });
    // Reset singleton
    (DeploymentSettingsPanel as any).currentPanel = undefined;
  });

  it('sends init message with servers and credentials on panel open', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    // Trigger 'ready' from webview
    await messageHandler({ command: 'ready' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'init',
      servers: serversMock,
      credentials: credentialsMock,
    }));
  });

  it('handles saveServer message: calls ServerManager.save, posts serverSaved back', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    const server = { id: 'srv-1', name: 'Production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload: server });
    expect(mockServerManager.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Production' }));
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'serverSaved' }));
  });

  it('saveServer shows info notification with server name after save', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    const server = { id: 'srv-1', name: 'Production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload: server });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Production')
    );
  });

  it('handles deleteServer message: shows confirmation, deletes on confirm', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'deleteServer', id: 'srv-1' });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Production'), 'Delete', 'Cancel'
    );
    expect(mockServerManager.delete).toHaveBeenCalledWith('srv-1');
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'serverDeleted', id: 'srv-1' });
  });

  it('handles deleteServer message: does nothing when user cancels', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'deleteServer', id: 'srv-1' });
    expect(mockServerManager.delete).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'serverDeleted' }));
  });

  it('handles setDefaultServer message: updates ProjectBinding defaultServerId', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'setDefaultServer', id: 'srv-1' });
    expect(mockBindingManager.setDefaultServer).toHaveBeenCalledWith('srv-1');
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'bindingUpdated' }));
  });

  it('handles saveMapping message: updates ProjectBinding server mappings', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    const serverBinding = { mappings: [{ localPath: '/', remotePath: '/var/www' }], excludedPaths: [] };
    await messageHandler({ command: 'saveMapping', serverId: 'srv-1', serverBinding });
    expect(mockBindingManager.setServerBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({
      mappings: serverBinding.mappings,
      excludedPaths: serverBinding.excludedPaths,
    }));
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'mappingSaved' }));
  });

  it('saveMapping shows info notification with server name after save', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    const serverBinding = { mappings: [{ localPath: '/', remotePath: '/var/www' }], excludedPaths: [] };
    await messageHandler({ command: 'saveMapping', serverId: 'srv-1', serverBinding });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Production')
    );
  });

  it('saveMapping preserves existing rootPathOverride from project binding', async () => {
    const bindingWithOverride = {
      ...bindingMock,
      servers: { 'srv-1': { mappings: [], excludedPaths: [], rootPathOverride: '/home/deploy/app' } },
    };
    (mockBindingManager.getBinding as jest.Mock).mockResolvedValue(bindingWithOverride);
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    const serverBinding = { mappings: [{ localPath: '/', remotePath: '/var/www' }], excludedPaths: [] };
    await messageHandler({ command: 'saveMapping', serverId: 'srv-1', serverBinding });
    expect(mockBindingManager.setServerBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({
      rootPathOverride: '/home/deploy/app',
    }));
  });

  it('handles deleteMapping message: removes mapping entry', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'deleteMapping', serverId: 'srv-1', index: 0 });
    expect(mockBindingManager.setServerBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({
      mappings: [],
    }));
  });

  it('handles testConnection message: calls SftpService, posts result', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (SftpService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'testConnection', serverId: 'srv-1' });
    expect(mockConnect).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: true,
    }));
  });

  it('posts validation error back if saveServer payload is invalid', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    // Missing name and credentialId
    await messageHandler({ command: 'saveServer', payload: { id: '', name: '', type: 'sftp', credentialId: '', rootPath: '/var/www' } });
    expect(mockServerManager.save).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'validationError',
    }));
  });

  // ── Issue 3: validate before test connection ──────────────────────────────

  it('testConnection fails early with testResult if stored server fails validation', async () => {
    const invalidServer = { id: 'srv-1', name: 'Production', type: 'sftp', credentialId: '', rootPath: '/var/www' };
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(invalidServer);
    const mockConnect = jest.fn();
    (SftpService as jest.Mock).mockImplementation(() => ({ connect: mockConnect, disconnect: jest.fn() }));
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'testConnection', serverId: 'srv-1' });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: false,
    }));
  });

  // ── Issue 2: cloneServer ──────────────────────────────────────────────────

  it('cloneServer creates a copy with a new id and "(copy)" suffix', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'cloneServer', id: 'srv-1' });
    expect(mockServerManager.save).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Production (copy)',
      credentialId: 'cred-1',
      rootPath: '/var/www',
    }));
    const saved = (mockServerManager.save as jest.Mock).mock.calls[0][0];
    expect(saved.id).not.toBe('srv-1');
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'serverSaved' }));
  });

  it('cloneServer appends timestamp when "(copy)" name is already taken', async () => {
    const existing = [
      ...serversMock,
      { id: 'srv-2', name: 'Production (copy)', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' },
    ];
    (mockServerManager.getAll as jest.Mock).mockResolvedValue(existing);
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'cloneServer', id: 'srv-1' });
    const saved = (mockServerManager.save as jest.Mock).mock.calls[0][0];
    expect(saved.name).toMatch(/^Production \(copy \d+\)$/);
  });

  it('cloneServer does nothing when server id is not found', async () => {
    (mockServerManager.getServer as jest.Mock).mockResolvedValue(undefined);
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'cloneServer', id: 'unknown' });
    expect(mockServerManager.save).not.toHaveBeenCalled();
  });

  // ── Issue 2: saveRootPathOverride ─────────────────────────────────────────

  it('saveRootPathOverride saves the override to the project binding', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'saveRootPathOverride', serverId: 'srv-1', rootPathOverride: '/home/deploy/app' });
    expect(mockBindingManager.setServerBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({
      rootPathOverride: '/home/deploy/app',
    }));
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'rootPathOverrideSaved',
      serverId: 'srv-1',
      rootPathOverride: '/home/deploy/app',
    }));
  });

  it('saveRootPathOverride clears the override when value is empty', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'saveRootPathOverride', serverId: 'srv-1', rootPathOverride: '' });
    expect(mockBindingManager.setServerBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({
      rootPathOverride: undefined,
    }));
  });

  it('saveRootPathOverride rejects a path that does not start with /', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'saveRootPathOverride', serverId: 'srv-1', rootPathOverride: 'var/www' });
    expect(mockBindingManager.setServerBinding).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'validationError',
      errors: { rootPathOverride: expect.any(String) },
    }));
  });

  // ── Issue 1: browseDirectory ──────────────────────────────────────────────

  it('browseDirectory: user selects a folder → posts directorySelected', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const mockListDirectory = jest.fn().mockResolvedValue([
      { name: 'html', type: 'd' },
      { name: 'logs', type: 'd' },
    ]);
    (SftpService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      label: '$(check) Select this folder',
      description: '/var/www',
    });
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/var/www' });
    expect(mockConnect).toHaveBeenCalled();
    expect(mockListDirectory).toHaveBeenCalledWith('/var/www');
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'directorySelected', path: '/var/www' });
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('browseDirectory: user navigates into a subdirectory then selects', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const mockListDirectory = jest.fn().mockResolvedValue([{ name: 'html', type: 'd' }]);
    (SftpService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
    }));
    (vscode.window.showQuickPick as jest.Mock)
      .mockResolvedValueOnce({ label: '$(folder) html' })
      .mockResolvedValueOnce({ label: '$(check) Select this folder', description: '/var/www/html' });
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/var/www' });
    // preflight + /var/www loop + /var/www/html loop = 3 calls
    expect(mockListDirectory).toHaveBeenCalledTimes(3);
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'directorySelected', path: '/var/www/html' });
  });

  it('browseDirectory: user dismisses QuickPick → no directorySelected message', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (SftpService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: jest.fn().mockResolvedValue([]),
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/' });
    expect(mockWebview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'directorySelected' }));
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('browseDirectory: falls back to home directory when startPath is not listable', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const mockListDirectory = jest.fn()
      .mockRejectedValueOnce(new Error('Permission denied /'))  // initial / fails
      .mockResolvedValue([{ name: 'html', type: 'd' }]);         // home dir succeeds
    const mockResolveRemotePath = jest.fn().mockResolvedValue('/home/deploy');
    (SftpService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
      resolveRemotePath: mockResolveRemotePath,
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      label: '$(check) Select this folder',
      description: '/home/deploy',
    });
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/' });
    expect(mockResolveRemotePath).toHaveBeenCalledWith('.');
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'directorySelected', path: '/home/deploy' });
  });

  it('browseDirectory: connection failure → posts browseError', async () => {
    (SftpService as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('Auth failed')),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'browseError',
      message: expect.stringContaining('Auth failed'),
    }));
  });

  it('browseDirectory: credential not found → posts browseError', async () => {
    (mockCredentialManager.getWithSecret as jest.Mock).mockRejectedValue(new Error('Not found'));
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'browseDirectory', credentialId: 'bad-id', startPath: '/' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'browseError',
    }));
  });

  it('pushes credentialsUpdated to webview when credentialsChanged event fires', async () => {
    let fireEvent: () => void = () => {};
    const credentialsChanged = (listener: () => void) => {
      fireEvent = listener;
      return { dispose: jest.fn() };
    };
    DeploymentSettingsPanel.createOrShow(mockContext, { ...deps(), credentialsChanged });
    jest.clearAllMocks();
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([...credentialsMock, { id: 'cred-2', name: 'Staging SSH', host: 'staging.example.com', port: 22, username: 'deploy', authMethod: 'password' }]);
    fireEvent();
    await new Promise(process.nextTick); // flush async pushUpdatedCredentials
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'credentialsUpdated',
      credentials: expect.arrayContaining([expect.objectContaining({ id: 'cred-2' })]),
    }));
  });

  it('only creates one panel instance (singleton pattern)', () => {
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    DeploymentSettingsPanel.createOrShow(mockContext, deps());
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mockPanel.reveal).toHaveBeenCalledTimes(1);
  });
});
