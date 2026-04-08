import * as vscode from 'vscode';
import { SshCredentialPanel } from '../../../ui/webviews/SshCredentialPanel';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

jest.mock('../../../transferServiceFactory');
jest.mock('fs/promises', () => ({ stat: jest.fn() }));

import { createTransferService } from '../../../transferServiceFactory';
import * as fs from 'fs/promises';
const mockStat = fs.stat as jest.Mock;

// ─── Webview mock ─────────────────────────────────────────────────────────────

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
  onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
  dispose: jest.fn(),
};

(vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);

// ─── Context mock ─────────────────────────────────────────────────────────────

const mockContext = {
  extensionUri: { fsPath: '/ext' },
  subscriptions: [],
} as unknown as vscode.ExtensionContext;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const credentialFixture = {
  id: 'cred-1', name: 'Prod SSH', host: 'example.com',
  port: 22, username: 'deploy', authMethod: 'password' as const,
};

const keyCredentialFixture = {
  id: 'cred-2', name: 'Key Auth', host: 'example.com',
  port: 22, username: 'deploy', authMethod: 'key' as const,
  privateKeyPath: '/home/user/.ssh/id_rsa',
};

// ─── Manager mocks ────────────────────────────────────────────────────────────

const mockCredentialManager = {
  getAll: jest.fn().mockResolvedValue([credentialFixture]),
  getWithSecret: jest.fn().mockResolvedValue({ ...credentialFixture, password: 'stored-password' }),
  save: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
} as unknown as CredentialManager;

const mockConfigManager = {
  getConfig: jest.fn().mockResolvedValue({ defaultServerId: '', servers: {} }),
} as unknown as ProjectConfigManager;

function deps() {
  return { credentialManager: mockCredentialManager, configManager: mockConfigManager };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SshCredentialPanel message handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([credentialFixture]);
    (mockCredentialManager.getWithSecret as jest.Mock).mockResolvedValue({ ...credentialFixture, password: 'stored-password' });
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ defaultServerId: '', servers: {} });
    mockStat.mockResolvedValue({ mode: 0o100600 }); // 600 by default
    (DeploymentSettingsPanel_reset as any)();
    (SshCredentialPanel as any).currentPanel = undefined;
  });

  it('creates panel with generic title "Credentials" (not SSH-specific)', () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      expect.anything(),
      'FileFerry: Credentials',
      expect.anything(),
      expect.anything()
    );
  });

  it('init message contains credentials without password or passphrase fields', async () => {
    // getAll() returns plain SshCredential — no password/passphrase fields
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'ready' });
    const call = (mockWebview.postMessage as jest.Mock).mock.calls[0][0];
    expect(call.command).toBe('init');
    expect(call.credentials).toHaveLength(1);
    expect(call.credentials[0].password).toBeUndefined();
    expect(call.credentials[0].passphrase).toBeUndefined();
  });

  it('saveCredential message stores secret fields via SecretStorage', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: { credential: credentialFixture, password: 'mypassword', passphrase: undefined },
    });
    expect(mockCredentialManager.save).toHaveBeenCalledWith(
      credentialFixture, 'mypassword', undefined
    );
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'credentialSaved',
    }));
  });

  it('saveCredential shows info notification with credential name after save', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: { credential: credentialFixture, password: 'mypassword', passphrase: undefined },
    });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Prod SSH')
    );
  });

  it('saveCredential message with empty password does not overwrite existing password', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: { credential: credentialFixture, password: '', passphrase: '' },
    });
    // Empty string → pass undefined so CredentialManager.save() skips the store call
    expect(mockCredentialManager.save).toHaveBeenCalledWith(
      credentialFixture, undefined, undefined
    );
  });

  it('deleteCredential shows confirmation then removes credential', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'deleteCredential', id: 'cred-1' });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Prod SSH'), 'Delete', 'Cancel'
    );
    expect(mockCredentialManager.delete).toHaveBeenCalledWith('cred-1');
    expect(mockWebview.postMessage).toHaveBeenCalledWith({
      command: 'credentialDeleted', id: 'cred-1',
    });
  });

  it('deleteCredential does nothing when user cancels', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'deleteCredential', id: 'cred-1' });
    expect(mockCredentialManager.delete).not.toHaveBeenCalled();
  });

  it('deleteCredential that is referenced by a server shows warning before deleting', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
      defaultServerId: 'srv-1',
      servers: {
        Production: { id: 'srv-1', type: 'sftp', credentialId: 'cred-1', credentialName: 'Prod SSH', rootPath: '/var/www', mappings: [], excludedPaths: [] },
      },
    });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined); // user cancels
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'deleteCredential', id: 'cred-1' });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Production'),
      expect.any(String), expect.any(String)
    );
    expect(mockCredentialManager.delete).not.toHaveBeenCalled();
  });

  it('testConnection temporarily assembles credential with provided password and tests', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: jest.fn().mockResolvedValue(undefined),
    }));
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'testConnection',
      credential: credentialFixture,
      password: 'typed-password',
      passphrase: undefined,
    });
    // Connect must receive the typed password
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'typed-password' }),
      expect.objectContaining({ password: 'typed-password' })
    );
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult', success: true,
    }));
  });

  it('testConnection with blank password fetches stored secret from keychain', async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: jest.fn().mockResolvedValue(undefined),
    }));
    (mockCredentialManager.getWithSecret as jest.Mock).mockResolvedValue({ ...credentialFixture, password: 'stored-password' });
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'testConnection',
      credential: credentialFixture,
      password: undefined,   // blank — user left field empty
      passphrase: undefined,
    });
    expect(mockCredentialManager.getWithSecret).toHaveBeenCalledWith('cred-1');
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'stored-password' }),
      expect.objectContaining({ password: 'stored-password' })
    );
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'testResult', success: true,
    }));
  });

  it('testConnection does not persist any changes to storage', async () => {
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }));
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'testConnection',
      credential: credentialFixture,
      password: 'typed-password',
      passphrase: undefined,
    });
    expect(mockCredentialManager.save).not.toHaveBeenCalled();
  });

  it('cloneCredential duplicates credential with new id and "(copy)" name', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'cloneCredential', id: 'cred-1' });
    expect(mockCredentialManager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Prod SSH (copy)',
        host: 'example.com',
      }),
      'stored-password',
      undefined
    );
    // New id, not the original
    const savedCred = (mockCredentialManager.save as jest.Mock).mock.calls[0][0];
    expect(savedCred.id).not.toBe('cred-1');
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'credentialSaved',
    }));
  });

  it('cloneCredential appends timestamp when "(copy)" name already exists', async () => {
    const existing = [
      credentialFixture,
      { ...credentialFixture, id: 'cred-copy', name: 'Prod SSH (copy)' },
    ];
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue(existing);
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'cloneCredential', id: 'cred-1' });
    const savedCred = (mockCredentialManager.save as jest.Mock).mock.calls[0][0];
    expect(savedCred.name).toMatch(/^Prod SSH \(copy \d+\)$/);
  });

  it('browsePrivateKey opens file dialog and sends path back to webview', async () => {
    const fakeUri = { fsPath: '/home/user/.ssh/id_rsa.pem' };
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([fakeUri]);
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'browsePrivateKey' });
    expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
    }));
    expect(mockWebview.postMessage).toHaveBeenCalledWith({
      command: 'privateKeySelected',
      path: '/home/user/.ssh/id_rsa.pem',
    });
  });

  it('browsePrivateKey does nothing when user cancels dialog', async () => {
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue(undefined);
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'browsePrivateKey' });
    expect(mockWebview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'privateKeySelected' })
    );
  });

  it('file permission warning shown when privateKeyPath file has 644 permissions', async () => {
    mockStat.mockResolvedValue({ mode: 0o100644 }); // 644 — too permissive
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: { credential: keyCredentialFixture, password: undefined, passphrase: '' },
    });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'warning',
      field: 'privateKeyPath',
    }));
  });
});

// Helper: reset DeploymentSettingsPanel singleton so it doesn't interfere
function DeploymentSettingsPanel_reset() {
  try {
    const { DeploymentSettingsPanel } = require('../../../ui/webviews/DeploymentSettingsPanel');
    (DeploymentSettingsPanel as any).currentPanel = undefined;
  } catch {}
}
