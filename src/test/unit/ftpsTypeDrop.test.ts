import * as vscode from 'vscode';
import { DeploymentSettingsPanel } from '../../ui/webviews/DeploymentSettingsPanel';
import { FtpService } from '../../ftpService';
import { FileDateGuard } from '../../services/FileDateGuard';
import { BackupService } from '../../services/BackupService';
import { UploadOrchestratorV2 } from '../../services/UploadOrchestratorV2';
import { DiffService } from '../../diffService';
import { toConnectTarget } from '../../connectTarget';
import type { CredentialManager } from '../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../storage/ProjectConfigManager';
import type { ServerType } from '../../types';

// The FTPS type-drop bug (feature 35 pre-work): an `ftps` / `ftps-implicit`
// server must reach basic-ftp's `access()` with `secure: true` / `'implicit'`
// on EVERY path, not only the Servers-tree Test Connection. The transport
// factory is real here — only basic-ftp itself is mocked — so what is
// asserted is the TLS mode the server would actually be dialed with.

const mockAccess = jest.fn().mockResolvedValue(undefined);
const mockClient = {
  access: mockAccess,
  uploadFrom: jest.fn().mockResolvedValue(undefined),
  downloadTo: jest.fn().mockResolvedValue(undefined),
  list: jest.fn().mockResolvedValue([]),
  ensureDir: jest.fn().mockResolvedValue(undefined),
  pwd: jest.fn().mockResolvedValue('/'),
  cd: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue(undefined),
  close: jest.fn(),
  ftp: { socket: { remoteAddress: '1.2.3.4' } },
  closed: false,
};

jest.mock('basic-ftp', () => ({
  Client: jest.fn().mockImplementation(() => mockClient),
}));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn().mockReturnValue('mock-read-stream'),
  statSync: jest.fn().mockReturnValue({ mtimeMs: 0 }),
}));
jest.mock('fs/promises');
jest.mock('../../services/TimeOffsetDetector', () => ({
  TimeOffsetDetector: jest.fn().mockImplementation(() => ({ detect: jest.fn().mockResolvedValue(0) })),
}));

const credential = {
  id: 'cred-1', name: 'FTPS box', host: 'files.example.com', port: 21,
  username: 'deploy', authMethod: 'password' as const, password: 'secret',
};

const tlsModes: Array<[ServerType, boolean | 'implicit']> = [
  ['ftps', true],
  ['ftps-implicit', 'implicit'],
  ['ftp', false],
];

function expectDialedWith(secure: boolean | 'implicit'): void {
  expect(mockAccess).toHaveBeenCalledTimes(1);
  expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({
    host: 'files.example.com', port: 21, user: 'deploy', password: 'secret', secure,
  }));
}

const item = { localPath: '/workspace/index.php', remotePath: '/var/www/index.php' };

describe('FTPS servers dial with TLS on every connect path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.closed = false;
    mockClient.list.mockResolvedValue([]);
  });

  describe('services fed by the shared builder (transport injected by type)', () => {
    it.each(tlsModes)('FileDateGuard.check — %s', async (type, secure) => {
      await new FileDateGuard(new FtpService()).check([item], toConnectTarget(credential, type));
      expectDialedWith(secure);
    });

    it.each(tlsModes)('FileDateGuard.partitionByNewerLocal — %s', async (type, secure) => {
      await new FileDateGuard(new FtpService()).partitionByNewerLocal([item], toConnectTarget(credential, type));
      expectDialedWith(secure);
    });

    it.each(tlsModes)('BackupService.backup — %s', async (type, secure) => {
      await new BackupService(new FtpService()).backup([item], toConnectTarget(credential, type), 'Prod', '/workspace');
      expectDialedWith(secure);
    });

    it.each(tlsModes)('UploadOrchestratorV2.upload — %s', async (type, secure) => {
      await new UploadOrchestratorV2(new FtpService()).upload([item], toConnectTarget(credential, type), null);
      expectDialedWith(secure);
    });

    it.each(tlsModes)('DiffService.downloadRemoteFile — %s', async (type, secure) => {
      const target = toConnectTarget(credential, type);
      await new DiffService(new FtpService(), '/tmp/fileferry').downloadRemoteFile(
        target, { password: target.password }, '/var/www/index.php'
      );
      expectDialedWith(secure);
    });
  });

  describe('Deployment Settings panel (real transport factory)', () => {
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
    const mockContext = { extensionUri: { fsPath: '/ext' }, subscriptions: [] } as unknown as vscode.ExtensionContext;
    const mockCredentialManager = {
      getAll: jest.fn().mockResolvedValue([credential]),
      getWithSecret: jest.fn().mockResolvedValue(credential),
    } as unknown as CredentialManager;
    const mockConfigManager = {
      getConfig: jest.fn().mockResolvedValue({ defaultServerId: 'srv-1', servers: {} }),
      saveConfig: jest.fn().mockResolvedValue(undefined),
      getServerById: jest.fn().mockResolvedValue(undefined),
    } as unknown as ProjectConfigManager;

    beforeEach(() => {
      (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      (DeploymentSettingsPanel as any).currentPanel = undefined;
      DeploymentSettingsPanel.createOrShow(mockContext, {
        credentialManager: mockCredentialManager, configManager: mockConfigManager,
      });
    });

    it.each(tlsModes)('Test Connection — %s', async (type, secure) => {
      await messageHandler({ command: 'testConnection', server: { type, credentialId: 'cred-1', rootPath: '' } });
      expectDialedWith(secure);
      expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'testResult', success: true }));
    });

    it.each(tlsModes)('Detect time offset — %s', async (type, secure) => {
      await messageHandler({ command: 'detectTimeOffset', server: { type, credentialId: 'cred-1' } });
      expectDialedWith(secure);
    });

    it.each(tlsModes)('Browse remote directory — %s', async (type, secure) => {
      await messageHandler({ command: 'browseDirectory', credentialId: 'cred-1', startPath: '/', serverType: type });
      expectDialedWith(secure);
    });
  });
});
