import * as vscode from 'vscode';
import { DeploymentSettingsPanel } from '../../../ui/webviews/DeploymentSettingsPanel';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

jest.mock('../../../transferServiceFactory');
jest.mock('../../../services/TimeOffsetDetector');

import { createTransferService } from '../../../transferServiceFactory';
import { TimeOffsetDetector } from '../../../services/TimeOffsetDetector';

const mockDetect = jest.fn().mockResolvedValue(0);
(TimeOffsetDetector as jest.Mock).mockImplementation(() => ({ detect: mockDetect }));

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

// --- Fixtures ---
const credentialsMock = [{ id: 'cred-1', name: 'Prod SSH', host: 'example.com', port: 22, username: 'deploy', authMethod: 'password' }];

const serverFixture = {
  id: 'srv-1',
  type: 'sftp' as const,
  credentialId: 'cred-1',
  credentialName: 'Prod SSH',
  rootPath: '/var/www',
  mappings: [{ localPath: '/', remotePath: '/var/www' }],
  excludedPaths: ['node_modules'],
};

const configFixture = {
  defaultServerId: 'srv-1',
  servers: {
    Production: serverFixture,
  },
};

// --- Manager mocks ---
const mockCredentialManager = {
  getAll: jest.fn().mockResolvedValue(credentialsMock),
  getWithSecret: jest.fn().mockResolvedValue({ ...credentialsMock[0], password: 'secret' }),
} as unknown as CredentialManager;

const mockConfigManager = {
  getConfig: jest.fn().mockResolvedValue(configFixture),
  saveConfig: jest.fn().mockResolvedValue(undefined),
  addServer: jest.fn().mockResolvedValue(undefined),
  removeServer: jest.fn().mockResolvedValue(undefined),
  renameServer: jest.fn().mockResolvedValue(undefined),
  setDefaultServer: jest.fn().mockResolvedValue(undefined),
  getServerById: jest.fn().mockResolvedValue({ name: 'Production', server: serverFixture }),
  getServer: jest.fn().mockResolvedValue(serverFixture),
  getServerNames: jest.fn().mockResolvedValue(['Production']),
} as unknown as ProjectConfigManager;

function dependencies() {
  return { credentialManager: mockCredentialManager, configManager: mockConfigManager };
}

describe('DeploymentSettingsPanel message handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetect.mockResolvedValue(0);
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configFixture);
    (mockConfigManager.saveConfig as jest.Mock).mockResolvedValue(undefined);
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue({ name: 'Production', server: serverFixture });
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue(credentialsMock);
    (mockCredentialManager.getWithSecret as jest.Mock).mockResolvedValue({ ...credentialsMock[0], password: 'secret' });
    // Reset singleton
    (DeploymentSettingsPanel as any).currentPanel = undefined;
  });

  it('sends init message with config and credentials on panel open', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'ready' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'init',
      config: configFixture,
      credentials: credentialsMock,
    }));
  });

  it('handles saveServer message: saves to config, posts configUpdated back', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { id: 'srv-1', name: 'Production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload });
    expect(mockConfigManager.saveConfig).toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'configUpdated' }));
  });

  it('saveServer shows info notification with server name after save', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { id: 'srv-1', name: 'Production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Production')
    );
  });

  it('saveServer creates new server with generated id when no id provided', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ defaultServerId: '', servers: {} });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { name: 'Staging', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www/staging' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers.Staging).toBeDefined();
    expect(savedConfig.servers.Staging.id).toBeDefined();
    expect(savedConfig.servers.Staging.credentialId).toBe('cred-1');
  });

  it('saveServer sets credentialName from credential lookup', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ defaultServerId: '', servers: {} });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { name: 'Staging', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers.Staging.credentialName).toBe('Prod SSH');
  });

  it('saveServer preserves existing mappings and excludedPaths on edit', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { id: 'srv-1', name: 'Production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www/html' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers.Production.mappings).toEqual(serverFixture.mappings);
    expect(savedConfig.servers.Production.excludedPaths).toEqual(serverFixture.excludedPaths);
  });

  it('saveServer renames config key when server name changes', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { id: 'srv-1', name: 'Prod Renamed', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers['Prod Renamed']).toBeDefined();
    expect(savedConfig.servers['Production']).toBeUndefined();
  });

  it('handles deleteServer message: shows confirmation, deletes on confirm', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'deleteServer', id: 'srv-1' });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Production'), 'Delete', 'Cancel'
    );
    expect(mockConfigManager.removeServer).toHaveBeenCalledWith('Production');
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'configUpdated' }));
  });

  it('handles deleteServer message: does nothing when user cancels', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'deleteServer', id: 'srv-1' });
    expect(mockConfigManager.removeServer).not.toHaveBeenCalled();
  });

  it('handles setDefaultServer message: updates config defaultServerId', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'setDefaultServer', id: 'srv-1' });
    expect(mockConfigManager.setDefaultServer).toHaveBeenCalledWith('srv-1');
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'configUpdated' }));
  });

  it('handles saveMapping message: updates server mappings in config', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const mappings = [{ localPath: '/', remotePath: '/var/www' }];
    const excludedPaths = ['node_modules'];
    await messageHandler({ command: 'saveMapping', serverId: 'srv-1', mappings, excludedPaths });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers.Production.mappings).toEqual(mappings);
    expect(savedConfig.servers.Production.excludedPaths).toEqual(excludedPaths);
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'configUpdated' }));
  });

  it('saveMapping shows info notification with server name after save', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const mappings = [{ localPath: '/', remotePath: '/var/www' }];
    await messageHandler({ command: 'saveMapping', serverId: 'srv-1', mappings, excludedPaths: [] });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Production')
    );
  });

  it('handles deleteMapping message: removes mapping entry', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'deleteMapping', serverId: 'srv-1', index: 0 });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers.Production.mappings).toEqual([]);
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'configUpdated' }));
  });

  it('handles testConnection message: calls SftpService, posts result', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { id: 'srv-1', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(mockConnect).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: true,
    }));
  });

  it('posts validation error back if saveServer payload is invalid', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'saveServer', payload: { name: '', type: 'sftp', credentialId: '', rootPath: '/var/www' } });
    expect(mockConfigManager.saveConfig).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'validationError',
    }));
  });

  it('testConnection fails early with testResult if server has invalid credential', async () => {
    const mockConnect = jest.fn();
    (createTransferService as jest.Mock).mockImplementation(() => ({ connect: mockConnect, disconnect: jest.fn() }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { id: 'srv-1', type: 'sftp', credentialId: '', rootPath: '/var/www' } });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: false,
    }));
  });

  it('cloneServer creates a copy with a new id and "(copy)" suffix', async () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'cloneServer', id: 'srv-1' });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    const clone = savedConfig.servers['Production (copy)'];
    expect(clone).toBeDefined();
    expect(clone.id).not.toBe('srv-1');
    expect(clone.credentialId).toBe('cred-1');
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'configUpdated' }));
  });

  it('cloneServer appends timestamp when "(copy)" name is already taken', async () => {
    const configWithCopy = {
      ...configFixture,
      servers: {
        ...configFixture.servers,
        'Production (copy)': { ...serverFixture, id: 'srv-2' },
      },
    };
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configWithCopy);
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'cloneServer', id: 'srv-1' });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    const cloneNames = Object.keys(savedConfig.servers).filter(n => n.startsWith('Production (copy'));
    expect(cloneNames.length).toBeGreaterThanOrEqual(2);
  });

  it('cloneServer does nothing when server id is not found', async () => {
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue(undefined);
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'cloneServer', id: 'unknown' });
    expect(mockConfigManager.saveConfig).not.toHaveBeenCalled();
  });

  // ── browseDirectory ──────────────────────────────────────────────────────────

  it('browseDirectory: user selects a folder → posts directorySelected', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const mockListDirectory = jest.fn().mockResolvedValue([
      { name: 'html', type: 'd' },
      { name: 'logs', type: 'd' },
    ]);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      label: '$(check) Select this folder',
      description: '/var/www',
    });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
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
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
    }));
    (vscode.window.showQuickPick as jest.Mock)
      .mockResolvedValueOnce({ label: '$(folder) html' })
      .mockResolvedValueOnce({ label: '$(check) Select this folder', description: '/var/www/html' });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/var/www' });
    // preflight + /var/www loop + /var/www/html loop = 3 calls
    expect(mockListDirectory).toHaveBeenCalledTimes(3);
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'directorySelected', path: '/var/www/html' });
  });

  it('browseDirectory: user dismisses QuickPick → no directorySelected message', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: jest.fn().mockResolvedValue([]),
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/' });
    expect(mockWebview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'directorySelected' }));
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('browseDirectory: falls back to home directory when startPath is not listable', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const mockListDirectory = jest.fn()
      .mockRejectedValueOnce(new Error('Permission denied /'))
      .mockResolvedValue([{ name: 'html', type: 'd' }]);
    const mockResolveRemotePath = jest.fn().mockResolvedValue('/home/deploy');
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
      resolveRemotePath: mockResolveRemotePath,
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      label: '$(check) Select this folder',
      description: '/home/deploy',
    });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/' });
    expect(mockResolveRemotePath).toHaveBeenCalledWith('.');
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'directorySelected', path: '/home/deploy' });
  });

  it('browseDirectory: connection failure → posts browseError', async () => {
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('Auth failed')),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'browseError',
      message: expect.stringContaining('Auth failed'),
    }));
  });

  it('browseDirectory: credential not found → posts browseError', async () => {
    (mockCredentialManager.getWithSecret as jest.Mock).mockRejectedValue(new Error('Not found'));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'browseDirectory', credentialId: 'bad-id', startPath: '/' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'browseError',
    }));
  });

  it('browseDirectory: includes symlinked directories in picker', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const mockListDirectory = jest.fn().mockResolvedValue([
      { name: 'html', type: 'd' },
      { name: 'current', type: 'l' },
      { name: 'config.ini', type: 'l' },
    ]);
    const mockStatType = jest.fn()
      .mockResolvedValueOnce('d')   // current -> directory
      .mockResolvedValueOnce('-');  // config.ini -> file
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
      statType: mockStatType,
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      label: '$(check) Select this folder',
      description: '/var/www',
    });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/var/www' });
    // QuickPick should include both 'html' (real dir) and 'current' (symlinked dir)
    // but NOT 'config.ini' (symlink to file)
    const quickPickItems = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
    const labels = quickPickItems.map((item: any) => item.label);
    expect(labels).toContain('$(folder) html');
    expect(labels).toContain('$(folder) current');
    expect(labels).not.toContain('$(folder) config.ini');
  });

  it('pushes credentialsUpdated to webview when credentialsChanged event fires', async () => {
    let fireEvent: () => void = () => {};
    const credentialsChanged = (listener: () => void) => {
      fireEvent = listener;
      return { dispose: jest.fn() };
    };
    DeploymentSettingsPanel.createOrShow(mockContext, { ...dependencies(), credentialsChanged });
    jest.clearAllMocks();
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([...credentialsMock, { id: 'cred-2', name: 'Staging SSH', host: 'staging.example.com', port: 22, username: 'deploy', authMethod: 'password' }]);
    fireEvent();
    await new Promise(process.nextTick);
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'credentialsUpdated',
      credentials: expect.arrayContaining([expect.objectContaining({ id: 'cred-2' })]),
    }));
  });

  it('only creates one panel instance (singleton pattern)', () => {
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mockPanel.reveal).toHaveBeenCalledTimes(1);
  });

  // ── FTP/FTPS protocol support ────────────────────────────────────────────────

  it('testConnection creates transfer service matching the server type', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { id: 'srv-1', type: 'ftp', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(createTransferService).toHaveBeenCalledWith('ftp');
  });

  it('testConnection creates transfer service for ftps server type', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { id: 'srv-1', type: 'ftps', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(createTransferService).toHaveBeenCalledWith('ftps');
  });

  it('saveServer persists ftp type in project config', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ defaultServerId: '', servers: {} });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { name: 'FTP Server', type: 'ftp', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers['FTP Server'].type).toBe('ftp');
  });

  it('saveServer persists ftps type in project config', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ defaultServerId: '', servers: {} });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { name: 'FTPS Server', type: 'ftps', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers['FTPS Server'].type).toBe('ftps');
  });

  it('saveServer persists ftps-implicit type in project config', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ defaultServerId: '', servers: {} });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { name: 'Implicit FTPS', type: 'ftps-implicit', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers['Implicit FTPS'].type).toBe('ftps-implicit');
  });

  it('browseDirectory passes serverType to createTransferService', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const mockListDirectory = jest.fn().mockResolvedValue([]);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      label: '$(check) Select this folder',
      description: '/',
    });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/', serverType: 'ftps' });
    expect(createTransferService).toHaveBeenCalledWith('ftps');
  });

  it('browseDirectory defaults to sftp when no serverType provided', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const mockListDirectory = jest.fn().mockResolvedValue([]);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listDirectory: mockListDirectory,
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      label: '$(check) Select this folder',
      description: '/',
    });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/' });
    expect(createTransferService).toHaveBeenCalledWith('sftp');
  });

  it('testConnection rejects FTP server using non-password credential', async () => {
    const keyCredential = { id: 'cred-key', name: 'Key Auth', host: 'example.com', port: 22, username: 'deploy', authMethod: 'key', privateKeyPath: '~/.ssh/id_rsa' };
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([keyCredential]);
    (mockCredentialManager.getWithSecret as jest.Mock).mockResolvedValue({ ...keyCredential, passphrase: 'secret' });
    const mockConnect = jest.fn();
    (createTransferService as jest.Mock).mockImplementation(() => ({ connect: mockConnect, disconnect: jest.fn() }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { id: 'srv-1', type: 'ftp', credentialId: 'cred-key', rootPath: '/var/www' } });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: false,
      message: expect.stringContaining('password'),
    }));
  });

  it('saveServer preserves filePermissions and directoryPermissions from payload', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
      defaultServerId: 'srv-1',
      servers: { Production: { ...serverFixture } },
    });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = {
      id: 'srv-1',
      name: 'Production',
      type: 'sftp',
      credentialId: 'cred-1',
      rootPath: '/var/www',
      filePermissions: 0o644,
      directoryPermissions: 0o755,
    };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers['Production'].filePermissions).toBe(0o644);
    expect(savedConfig.servers['Production'].directoryPermissions).toBe(0o755);
  });

  it('saveServer saves server without permissions when fields are omitted', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
      defaultServerId: 'srv-1',
      servers: { Production: { ...serverFixture } },
    });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { id: 'srv-1', name: 'Production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers['Production'].filePermissions).toBeUndefined();
    expect(savedConfig.servers['Production'].directoryPermissions).toBeUndefined();
  });

  it('saveServer preserves existing timeOffsetMs when saving other fields', async () => {
    const serverWithOffset = { ...serverFixture, timeOffsetMs: 250 };
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
      defaultServerId: 'srv-1',
      servers: { Production: serverWithOffset },
    });
    (mockConfigManager.getServerById as jest.Mock).mockResolvedValue({ name: 'Production', server: serverWithOffset });
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    const payload = { id: 'srv-1', name: 'Production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www/html' };
    await messageHandler({ command: 'saveServer', payload });
    const savedConfig = (mockConfigManager.saveConfig as jest.Mock).mock.calls[0][0];
    expect(savedConfig.servers['Production'].timeOffsetMs).toBe(250);
  });

  // ── Time offset detection ────────────────────────────────────────────────────

  it('testConnection includes detected timeOffsetMs in testResult', async () => {
    mockDetect.mockResolvedValue(250);
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { id: 'srv-1', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: true,
      timeOffsetMs: 250,
    }));
  });

  it('testConnection saves detected offset to server config', async () => {
    mockDetect.mockResolvedValue(250);
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { id: 'srv-1', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(mockConfigManager.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: expect.objectContaining({
          Production: expect.objectContaining({ timeOffsetMs: 250 }),
        }),
      })
    );
  });

  it('handles detectTimeOffset message: saves offset and posts testResult with timeOffsetMs', async () => {
    mockDetect.mockResolvedValue(500);
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'detectTimeOffset', server: { id: 'srv-1', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(mockConnect).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockConfigManager.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: expect.objectContaining({
          Production: expect.objectContaining({ timeOffsetMs: 500 }),
        }),
      })
    );
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: true,
      timeOffsetMs: 500,
    }));
  });

  // ── Test connection for unsaved (new) servers ────────────────────────────────

  it('testConnection works for an unsaved server before it has been saved', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    // No id — server has not been saved yet
    await messageHandler({ command: 'testConnection', server: { type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(mockConnect).toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: true,
    }));
  });

  it('testConnection for unsaved server does not save config', async () => {
    mockDetect.mockResolvedValue(100);
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(mockConfigManager.saveConfig).not.toHaveBeenCalled();
    // offset is still returned to the webview
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: true,
      timeOffsetMs: 100,
    }));
  });

  it('testConnection fails with testResult when no credential is selected', async () => {
    const mockConnect = jest.fn();
    (createTransferService as jest.Mock).mockImplementation(() => ({ connect: mockConnect, disconnect: jest.fn() }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'testConnection', server: { type: 'sftp', credentialId: '', rootPath: '/var/www' } });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: false,
    }));
  });

  it('detectTimeOffset for unsaved server detects offset but does not save config', async () => {
    mockDetect.mockResolvedValue(300);
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
    }));
    DeploymentSettingsPanel.createOrShow(mockContext, dependencies());
    await messageHandler({ command: 'detectTimeOffset', server: { type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' } });
    expect(mockConnect).toHaveBeenCalled();
    expect(mockConfigManager.saveConfig).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult',
      success: true,
      timeOffsetMs: 300,
    }));
  });
});
