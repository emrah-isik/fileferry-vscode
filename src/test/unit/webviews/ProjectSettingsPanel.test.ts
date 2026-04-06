import * as vscode from 'vscode';
import { ProjectSettingsPanel } from '../../../ui/webviews/ProjectSettingsPanel';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

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
const configFixture = {
  defaultServerId: 'srv-1',
  uploadOnSave: false,
  fileDateGuard: true,
  servers: {
    Production: {
      id: 'srv-1',
      type: 'sftp' as const,
      credentialId: 'cred-1',
      credentialName: 'Prod SSH',
      rootPath: '/var/www',
      mappings: [],
      excludedPaths: [],
    },
  },
};

// --- Manager mock ---
const mockConfigManager = {
  getConfig: jest.fn().mockResolvedValue(configFixture),
  saveConfig: jest.fn().mockResolvedValue(undefined),
  toggleUploadOnSave: jest.fn().mockResolvedValue(true),
  toggleFileDateGuard: jest.fn().mockResolvedValue(false),
} as unknown as ProjectConfigManager;

describe('ProjectSettingsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configFixture);
    // Reset singleton
    (ProjectSettingsPanel as any).currentPanel = undefined;
  });

  it('sends init with config on ready', async () => {
    ProjectSettingsPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    await messageHandler({ command: 'ready' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'init',
      config: configFixture,
    }));
  });

  it('only creates one panel instance (singleton pattern)', () => {
    ProjectSettingsPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    ProjectSettingsPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mockPanel.reveal).toHaveBeenCalledTimes(1);
  });

  it('handles toggleUploadOnSave: calls manager and posts configUpdated', async () => {
    (mockConfigManager.toggleUploadOnSave as jest.Mock).mockResolvedValue(true);
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, uploadOnSave: true });
    ProjectSettingsPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    await messageHandler({ command: 'toggleUploadOnSave' });
    expect(mockConfigManager.toggleUploadOnSave).toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'configUpdated',
    }));
  });

  it('handles toggleFileDateGuard: calls manager and posts configUpdated', async () => {
    (mockConfigManager.toggleFileDateGuard as jest.Mock).mockResolvedValue(false);
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ ...configFixture, fileDateGuard: false });
    ProjectSettingsPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    await messageHandler({ command: 'toggleFileDateGuard' });
    expect(mockConfigManager.toggleFileDateGuard).toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'configUpdated',
    }));
  });

  it('disposes cleanly and allows re-creation', () => {
    ProjectSettingsPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    // Trigger dispose
    const disposeHandler = mockPanel.onDidDispose.mock.calls[0][0];
    disposeHandler();
    // Now creating again should make a new panel
    ProjectSettingsPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });
});
