import * as vscode from 'vscode';
import { SshCredentialPanel } from '../../../ui/webviews/SshCredentialPanel';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

jest.mock('../../../transferServiceFactory');
jest.mock('fs/promises', () => ({ stat: jest.fn() }));
jest.mock('../../../ssh/SshConfigResolver');

import { createTransferService } from '../../../transferServiceFactory';
import { describeResolution } from '../../../ssh/SshConfigResolver';
import * as fs from 'fs/promises';
const mockStat = fs.stat as jest.Mock;
const mockDescribeResolution = describeResolution as jest.Mock;

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
    mockDescribeResolution.mockReturnValue({ status: 'matched', lines: ['Resolved "prod" → deploy@10.0.0.1:22'] });
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

  it('createOrShow with selectCredentialId preselects that credential in the init message', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps(), { selectCredentialId: 'cred-1' });
    await messageHandler({ command: 'ready' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'init',
      selectedId: 'cred-1',
    }));
  });

  it('createOrShow without selectCredentialId sends init with no selectedId (webview falls back to first)', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'ready' });
    const initMessage = (mockWebview.postMessage as jest.Mock).mock.calls.find(c => c[0].command === 'init')[0];
    expect(initMessage.selectedId).toBeUndefined();
  });

  it('createOrShow with selectCredentialId while the panel is already open reveals it and switches the selection', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    (mockWebview.postMessage as jest.Mock).mockClear();
    SshCredentialPanel.createOrShow(mockContext, deps(), { selectCredentialId: 'cred-2' });
    expect(mockPanel.reveal).toHaveBeenCalled();
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'selectCredential', id: 'cred-2' });
  });

  it('createOrShow without selectCredentialId while the panel is already open only reveals — no selection change', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    (mockWebview.postMessage as jest.Mock).mockClear();
    SshCredentialPanel.createOrShow(mockContext, deps());
    expect(mockPanel.reveal).toHaveBeenCalled();
    expect(mockWebview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'selectCredential' }));
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

  it('saveCredential persists the useSshConfig flag', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: {
        credential: { ...credentialFixture, host: 'prod', username: '', useSshConfig: true },
        password: 'mypassword',
      },
    });
    const savedCredential = (mockCredentialManager.save as jest.Mock).mock.calls[0][0];
    expect(savedCredential.useSshConfig).toBe(true);
    expect(savedCredential.host).toBe('prod');
  });

  it('saveCredential omits useSshConfig when the flag is off', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: { credential: { ...credentialFixture, useSshConfig: false }, password: 'mypassword' },
    });
    const savedCredential = (mockCredentialManager.save as jest.Mock).mock.calls[0][0];
    expect(savedCredential.useSshConfig).toBeUndefined();
  });

  it('saveCredential posts an sshConfigSummary when useSshConfig is on', async () => {
    mockDescribeResolution.mockReturnValue({ status: 'no-match', lines: ['No matching Host entry for "prod"'] });
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: { credential: { ...credentialFixture, host: 'prod', useSshConfig: true }, password: 'mypassword' },
    });
    expect(mockDescribeResolution).toHaveBeenCalledWith(expect.objectContaining({ host: 'prod' }));
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'sshConfigSummary',
      status: 'no-match',
      lines: ['No matching Host entry for "prod"'],
    }));
  });

  it('saveCredential does not post an sshConfigSummary when useSshConfig is off', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: { credential: credentialFixture, password: 'mypassword' },
    });
    expect(mockDescribeResolution).not.toHaveBeenCalled();
    expect(mockWebview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'sshConfigSummary' })
    );
  });

  it('testConnection posts an sshConfigSummary before connecting when useSshConfig is on', async () => {
    mockDescribeResolution.mockReturnValue({ status: 'matched', lines: ['Resolved "prod" → deploy@10.0.0.1:2222'] });
    (createTransferService as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }));
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'testConnection',
      credential: { ...keyCredentialFixture, host: 'prod', useSshConfig: true },
    });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'sshConfigSummary',
      status: 'matched',
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

  // Delete guard (18a-2b, Q28/H5): a referenced credential cannot be deleted
  // at all — cascade-delete and warn-but-allow are both explicitly rejected.
  describe('delete guard (Q28/H5)', () => {
    const productionServer = {
      id: 'srv-1', type: 'sftp', credentialId: 'cred-1', credentialName: 'Prod SSH',
      rootPath: '/var/www', mappings: [], excludedPaths: [],
    };
    const chainedCredential = {
      id: 'cred-chained', name: 'Via Bastion', host: 'internal.example.com',
      port: 22, username: 'deploy', authMethod: 'password' as const,
      jumpHosts: ['cred-1'],
    };

    it('blocks deleting a credential referenced by a server, naming the server', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        defaultServerId: 'srv-1',
        servers: { Production: productionServer },
      });
      SshCredentialPanel.createOrShow(mockContext, deps());
      await messageHandler({ command: 'deleteCredential', id: 'cred-1' });
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Production')
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockCredentialManager.delete).not.toHaveBeenCalled();
    });

    it('blocks deleting a credential used as a jump host, naming the referencing credential', async () => {
      (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([
        credentialFixture, chainedCredential,
      ]);
      SshCredentialPanel.createOrShow(mockContext, deps());
      await messageHandler({ command: 'deleteCredential', id: 'cred-1' });
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('used as a jump host by: Via Bastion')
      );
      expect(mockCredentialManager.delete).not.toHaveBeenCalled();
    });

    it('blocks deleting a credential referenced by a server AND as a jump host, naming both', async () => {
      (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
        defaultServerId: 'srv-1',
        servers: { Production: productionServer },
      });
      (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([
        credentialFixture, chainedCredential,
      ]);
      SshCredentialPanel.createOrShow(mockContext, deps());
      await messageHandler({ command: 'deleteCredential', id: 'cred-1' });
      const message = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0];
      expect(message).toContain('Production');
      expect(message).toContain('used as a jump host by: Via Bastion');
      expect(mockCredentialManager.delete).not.toHaveBeenCalled();
    });

    it('an unreferenced credential still deletes through the existing confirmation', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
      (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([
        credentialFixture,
        { ...chainedCredential, jumpHosts: ['cred-other'] },
      ]);
      SshCredentialPanel.createOrShow(mockContext, deps());
      await messageHandler({ command: 'deleteCredential', id: 'cred-1' });
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(mockCredentialManager.delete).toHaveBeenCalledWith('cred-1');
    });
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

  it('saveCredential round-trip: saving an unrelated field preserves jumpHosts and agentSocketPath (18a-2a, C4/R8-17)', async () => {
    // The webview passes non-form fields through untouched; the save whitelist
    // must not drop them when the user edits something unrelated (here: name).
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([
      credentialFixture,
      { id: 'cred-bastion', name: 'Bastion', host: 'bastion.example.com', port: 22, username: 'jump', authMethod: 'password' },
    ]);
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: {
        credential: {
          ...credentialFixture,
          name: 'Renamed SSH',
          agentSocketPath: '/run/user/1000/custom-agent.sock',
          jumpHosts: ['cred-bastion'],
        },
        password: undefined,
      },
    });
    expect(mockCredentialManager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Renamed SSH',
        agentSocketPath: '/run/user/1000/custom-agent.sock',
        jumpHosts: ['cred-bastion'],
      }),
      undefined,
      undefined
    );
  });

  it('saveCredential preserves picker hop order exactly (18a-2b, Q16)', async () => {
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([
      credentialFixture,
      { id: 'cred-hop-a', name: 'Hop A', host: 'a.example.com', port: 22, username: 'jump', authMethod: 'password' },
      { id: 'cred-hop-b', name: 'Hop B', host: 'b.example.com', port: 22, username: 'jump', authMethod: 'password' },
    ]);
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: {
        credential: { ...credentialFixture, jumpHosts: ['cred-hop-b', 'cred-hop-a'] },
        password: undefined,
      },
    });
    const savedCredential = (mockCredentialManager.save as jest.Mock).mock.calls[0][0];
    expect(savedCredential.jumpHosts).toEqual(['cred-hop-b', 'cred-hop-a']);
  });

  it('saveCredential omits jumpHosts when the list is empty', async () => {
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({
      command: 'saveCredential',
      payload: { credential: { ...credentialFixture, jumpHosts: [] }, password: undefined },
    });
    const savedCredential = (mockCredentialManager.save as jest.Mock).mock.calls[0][0];
    expect(savedCredential.jumpHosts).toBeUndefined();
  });

  it('cloneCredential preserves jumpHosts (18a-2a, C4)', async () => {
    (mockCredentialManager.getWithSecret as jest.Mock).mockResolvedValue({
      ...credentialFixture,
      jumpHosts: ['cred-bastion'],
      password: 'stored-password',
    });
    SshCredentialPanel.createOrShow(mockContext, deps());
    await messageHandler({ command: 'cloneCredential', id: 'cred-1' });
    expect(mockCredentialManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ jumpHosts: ['cred-bastion'] }),
      'stored-password',
      undefined
    );
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
