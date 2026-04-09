import * as vscode from 'vscode';

jest.mock('../../../services/UploadHistoryService');

import { UploadHistoryService } from '../../../services/UploadHistoryService';
import { UploadHistoryPanel } from '../../../ui/webviews/UploadHistoryPanel';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';
import type { UploadHistoryEntry } from '../../../models/UploadHistoryEntry';

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

const mockContext = {
  extensionUri: { fsPath: '/ext' },
  subscriptions: [],
} as unknown as vscode.ExtensionContext;

const entryFixture: UploadHistoryEntry = {
  id: 'e-1',
  timestamp: 1700000000000,
  serverId: 'srv-1',
  serverName: 'Production',
  localPath: '/workspace/src/app.php',
  remotePath: '/var/www/src/app.php',
  action: 'upload',
  result: 'success',
  trigger: 'manual',
};

const configFixture = {
  defaultServerId: 'srv-1',
  servers: {
    Production: { id: 'srv-1', type: 'sftp', credentialId: 'c1', credentialName: 'c', rootPath: '/var/www', mappings: [], excludedPaths: [] },
    Staging: { id: 'srv-2', type: 'sftp', credentialId: 'c2', credentialName: 'c', rootPath: '/var/staging', mappings: [], excludedPaths: [] },
  },
};

const mockGetAll = jest.fn().mockResolvedValue([entryFixture]);
const mockGetFiltered = jest.fn().mockResolvedValue([entryFixture]);
const mockClear = jest.fn().mockResolvedValue(undefined);

(UploadHistoryService as jest.Mock).mockImplementation(() => ({
  getAll: mockGetAll,
  getFiltered: mockGetFiltered,
  clear: mockClear,
}));

const mockConfigManager = {
  getConfig: jest.fn().mockResolvedValue(configFixture),
} as unknown as ProjectConfigManager;

describe('UploadHistoryPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(configFixture);
    mockGetAll.mockResolvedValue([entryFixture]);
    mockGetFiltered.mockResolvedValue([entryFixture]);
    (UploadHistoryService as jest.Mock).mockImplementation(() => ({
      getAll: mockGetAll,
      getFiltered: mockGetFiltered,
      clear: mockClear,
    }));
    (UploadHistoryPanel as any).currentPanel = undefined;
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  });

  it('sends init with entries and servers on ready', async () => {
    UploadHistoryPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    await messageHandler({ command: 'ready' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'init',
      entries: [entryFixture],
      servers: expect.arrayContaining([
        { id: 'srv-1', name: 'Production' },
        { id: 'srv-2', name: 'Staging' },
      ]),
    }));
  });

  it('only creates one panel instance (singleton pattern)', () => {
    UploadHistoryPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    UploadHistoryPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mockPanel.reveal).toHaveBeenCalledTimes(1);
  });

  it('handles filter message and returns filtered entries', async () => {
    UploadHistoryPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    await messageHandler({ command: 'filter', serverId: 'srv-1', result: 'success', search: 'app' });
    expect(mockGetFiltered).toHaveBeenCalledWith({ serverId: 'srv-1', result: 'success', search: 'app' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'filtered',
      entries: [entryFixture],
    }));
  });

  it('handles clear message: clears history and posts cleared', async () => {
    UploadHistoryPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    await messageHandler({ command: 'clear' });
    expect(mockClear).toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'cleared' });
  });

  it('disposes cleanly and allows re-creation', () => {
    UploadHistoryPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    const disposeHandler = mockPanel.onDidDispose.mock.calls[0][0];
    disposeHandler();
    UploadHistoryPanel.createOrShow(mockContext, { configManager: mockConfigManager });
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });
});
