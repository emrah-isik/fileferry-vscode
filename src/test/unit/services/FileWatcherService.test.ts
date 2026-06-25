import * as vscode from 'vscode';
import * as fs from 'fs';

jest.mock('fs', () => ({ statSync: jest.fn() }));
jest.mock('../../../services/autoUpload', () => ({
  autoUploadFile: jest.fn().mockResolvedValue({ status: 'uploaded', summary: { failed: [] }, serverName: 'Production', fileName: 'app.js' }),
}));

import { autoUploadFile } from '../../../services/autoUpload';

const mockStatSync = fs.statSync as unknown as jest.Mock;
import { FileWatcherService } from '../../../services/FileWatcherService';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockAutoUpload = autoUploadFile as jest.Mock;

// Capture the create/change callbacks the service registers, per watcher.
let createCallbacks: Array<(uri: any) => void>;
let changeCallbacks: Array<(uri: any) => void>;
let watcherDisposes: jest.Mock[];

function installWatcherCapture() {
  createCallbacks = [];
  changeCallbacks = [];
  watcherDisposes = [];
  (vscode.workspace.createFileSystemWatcher as jest.Mock).mockImplementation(() => {
    const dispose = jest.fn();
    watcherDisposes.push(dispose);
    return {
      onDidCreate: (cb: any) => { createCallbacks.push(cb); return { dispose: jest.fn() }; },
      onDidChange: (cb: any) => { changeCallbacks.push(cb); return { dispose: jest.fn() }; },
      onDidDelete: () => ({ dispose: jest.fn() }),
      dispose,
    };
  });
}

let configSubFire: () => void;
const mockConfigManager = {
  getConfig: jest.fn(),
  getServerById: jest.fn(),
  onDidSaveConfig: (cb: () => void) => { configSubFire = cb; return { dispose: jest.fn() }; },
} as unknown as ProjectConfigManager;

const mockOutput = { appendLine: jest.fn() } as unknown as vscode.OutputChannel;

function deps() {
  return {
    credentialManager: {} as CredentialManager,
    configManager: mockConfigManager,
    output: mockOutput,
  };
}

const uri = (fsPath: string) => ({ fsPath });

const watchConfig = (patterns: string[], enabled = true) => ({
  defaultServerId: 'srv-1',
  watch: { enabled, patterns },
  servers: {},
});

describe('FileWatcherService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    installWatcherCapture();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    mockAutoUpload.mockResolvedValue({ status: 'uploaded', summary: { failed: [] }, serverName: 'Production', fileName: 'app.js' });
    mockStatSync.mockReturnValue({ isDirectory: () => false }); // default: a regular file
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function startWith(config: any) {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(config);
    const service = new FileWatcherService(deps());
    const disposable = service.register();
    await jest.advanceTimersByTimeAsync(0); // let the async rebuild() settle
    return { service, disposable };
  }

  it('creates one watcher per pattern when watch is enabled', async () => {
    await startWith(watchConfig(['dist/**', 'build/**/*.js']));
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
  });

  it('creates no watchers when watch is disabled', async () => {
    await startWith(watchConfig(['dist/**'], false));
    expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled();
  });

  it('creates no watchers when patterns are empty', async () => {
    await startWith(watchConfig([]));
    expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled();
  });

  it('uploads each changed file after the debounce window', async () => {
    await startWith(watchConfig(['dist/**']));
    createCallbacks[0](uri('/workspace/dist/a.js'));
    changeCallbacks[0](uri('/workspace/dist/b.js'));

    expect(mockAutoUpload).not.toHaveBeenCalled(); // debounced, not yet
    await jest.advanceTimersByTimeAsync(400);

    expect(mockAutoUpload).toHaveBeenCalledTimes(2);
    expect(mockAutoUpload.mock.calls[0][0]).toBe('/workspace/dist/a.js');
    // the watcher always passes applyGitIgnore: false (the allowlist)
    expect(mockAutoUpload.mock.calls[0][5]).toEqual({ applyGitIgnore: false });
  });

  it('coalesces rapid repeated writes to the same file into one upload', async () => {
    await startWith(watchConfig(['dist/**']));
    changeCallbacks[0](uri('/workspace/dist/a.js'));
    changeCallbacks[0](uri('/workspace/dist/a.js'));
    changeCallbacks[0](uri('/workspace/dist/a.js'));
    await jest.advanceTimersByTimeAsync(400);

    expect(mockAutoUpload).toHaveBeenCalledTimes(1);
  });

  it('skips directory events (e.g. mkdir) — never tries to upload a directory', async () => {
    await startWith(watchConfig(['dist/**']));
    mockStatSync.mockImplementation((p: string) => ({ isDirectory: () => p === '/workspace/dist' }));
    createCallbacks[0](uri('/workspace/dist'));        // the directory itself
    createCallbacks[0](uri('/workspace/dist/app.js')); // the file inside
    await jest.advanceTimersByTimeAsync(400);

    expect(mockAutoUpload).toHaveBeenCalledTimes(1);
    expect(mockAutoUpload.mock.calls[0][0]).toBe('/workspace/dist/app.js');
  });

  it('skips files that vanished before the debounce fired', async () => {
    await startWith(watchConfig(['dist/**']));
    mockStatSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    changeCallbacks[0](uri('/workspace/dist/gone.js'));
    await jest.advanceTimersByTimeAsync(400);

    expect(mockAutoUpload).not.toHaveBeenCalled();
  });

  it('never uploads files under .fileferry-backups', async () => {
    await startWith(watchConfig(['**']));
    changeCallbacks[0](uri('/workspace/.fileferry-backups/2026/app.js'));
    await jest.advanceTimersByTimeAsync(400);

    expect(mockAutoUpload).not.toHaveBeenCalled();
  });

  it('logs instead of uploading under dry run', async () => {
    await startWith({ ...watchConfig(['dist/**']), dryRun: true });
    changeCallbacks[0](uri('/workspace/dist/a.js'));
    await jest.advanceTimersByTimeAsync(400);

    expect(mockAutoUpload).not.toHaveBeenCalled();
    expect(mockOutput.appendLine).toHaveBeenCalledWith(expect.stringContaining('dist/a.js'));
  });

  it('rebuilds watchers when the config changes', async () => {
    await startWith(watchConfig(['dist/**']));
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);
    const firstDispose = watcherDisposes[0];

    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(watchConfig(['build/**', 'out/**']));
    configSubFire();
    await jest.advanceTimersByTimeAsync(0);

    expect(firstDispose).toHaveBeenCalled(); // old watcher torn down
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(3); // 1 + 2
  });

  it('disposes child watchers on dispose', async () => {
    const { disposable } = await startWith(watchConfig(['dist/**']));
    disposable.dispose();
    expect(watcherDisposes[0]).toHaveBeenCalled();
  });
});
