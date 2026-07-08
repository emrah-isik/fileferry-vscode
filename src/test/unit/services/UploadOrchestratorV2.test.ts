import { UploadOrchestratorV2 } from '../../../services/UploadOrchestratorV2';
import type { ResolvedUploadItem } from '../../../path/PathResolver';
import type { CancellationToken } from 'vscode';

const mockSftp = {
  connect: jest.fn().mockResolvedValue(undefined),
  uploadFile: jest.fn().mockResolvedValue(undefined),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  chmod: jest.fn().mockResolvedValue(undefined),
  // Present so canExec() treats this mock as an SFTP transfer that can run
  // remote hooks (the orchestrator hands it to runHooks as `remote`).
  execCommand: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
};

jest.mock('../../../sftpService', () => ({
  SftpService: jest.fn().mockImplementation(() => mockSftp),
}));

jest.mock('../../../services/HookRunner', () => ({
  runHooks: jest.fn().mockResolvedValue({ ok: true }),
  preflightHookSecrets: jest.fn().mockReturnValue({ ok: true }),
}));
import { runHooks, preflightHookSecrets } from '../../../services/HookRunner';
const mockRunHooks = runHooks as jest.Mock;
const mockPreflight = preflightHookSecrets as jest.Mock;

const credential = { id: 'c1', host: 'h', port: 22, username: 'u', authMethod: 'password', password: 'p' } as any;
const server = { id: 's1', name: 'Prod', rootPath: '/var/www' } as any;

function item(name: string): ResolvedUploadItem {
  return { localPath: `/workspace/${name}`, remotePath: `/var/www/${name}` };
}

function makeCancellationToken(cancelled: boolean): CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: jest.fn(),
  };
}

describe('UploadOrchestratorV2 — cancellation', () => {
  let orchestrator: UploadOrchestratorV2;

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new UploadOrchestratorV2(mockSftp as any);
  });

  it('uploads all files when no token is provided', async () => {
    const items = [item('a.php'), item('b.php')];
    const result = await orchestrator.upload(items, credential, server);

    expect(mockSftp.uploadFile).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toHaveLength(2);
    expect(result.cancelled).toBeUndefined();
  });

  it('uploads all files when token is not cancelled', async () => {
    const token = makeCancellationToken(false);
    const items = [item('a.php'), item('b.php')];
    const result = await orchestrator.upload(items, credential, server, [], token);

    expect(mockSftp.uploadFile).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toHaveLength(2);
  });

  it('skips remaining uploads when token is cancelled before loop', async () => {
    const token = makeCancellationToken(true);
    const items = [item('a.php'), item('b.php')];
    const result = await orchestrator.upload(items, credential, server, [], token);

    expect(mockSftp.uploadFile).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual(items);
  });

  it('stops uploading mid-loop when cancellation is requested', async () => {
    let uploadCount = 0;
    const token: CancellationToken = {
      get isCancellationRequested() {
        // Cancel after the first upload completes
        return uploadCount >= 1;
      },
      onCancellationRequested: jest.fn(),
    };

    mockSftp.uploadFile.mockImplementation(async () => { uploadCount++; });

    const items = [item('a.php'), item('b.php'), item('c.php')];
    const result = await orchestrator.upload(items, credential, server, [], token);

    expect(mockSftp.uploadFile).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toHaveLength(1);
    expect(result.cancelled).toEqual([item('b.php'), item('c.php')]);
  });

  it('skips deletions when cancelled', async () => {
    const token = makeCancellationToken(true);
    const result = await orchestrator.upload([], credential, server, ['/var/www/old.php'], token);

    expect(mockSftp.deleteFile).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual([]);
  });

  it('still disconnects when cancelled', async () => {
    const token = makeCancellationToken(true);
    await orchestrator.upload([item('a.php')], credential, server, [], token);

    expect(mockSftp.disconnect).toHaveBeenCalled();
  });
});

describe('UploadOrchestratorV2 — deletions', () => {
  let orchestrator: UploadOrchestratorV2;

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new UploadOrchestratorV2(mockSftp as any);
  });

  it('deletes remote paths after uploads complete', async () => {
    const result = await orchestrator.upload([], credential, server, ['/var/www/old.php', '/var/www/stale.js']);

    expect(mockSftp.deleteFile).toHaveBeenCalledWith('/var/www/old.php');
    expect(mockSftp.deleteFile).toHaveBeenCalledWith('/var/www/stale.js');
    expect(result.deleted).toEqual(['/var/www/old.php', '/var/www/stale.js']);
    expect(result.deleteFailed).toHaveLength(0);
  });

  it('records failed deletions in deleteFailed without throwing', async () => {
    mockSftp.deleteFile.mockRejectedValueOnce(new Error('permission denied'));
    const result = await orchestrator.upload([], credential, server, ['/var/www/locked.php']);

    expect(result.deleted).toHaveLength(0);
    expect(result.deleteFailed).toEqual([{ remotePath: '/var/www/locked.php', error: 'permission denied' }]);
  });

  it('records partial results when some deletions succeed and some fail', async () => {
    mockSftp.deleteFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('not found'));

    const result = await orchestrator.upload([], credential, server, ['/var/www/a.php', '/var/www/b.php']);

    expect(result.deleted).toEqual(['/var/www/a.php']);
    expect(result.deleteFailed).toEqual([{ remotePath: '/var/www/b.php', error: 'not found' }]);
  });

  it('still disconnects when a deletion fails', async () => {
    mockSftp.deleteFile.mockRejectedValueOnce(new Error('oops'));
    await orchestrator.upload([], credential, server, ['/var/www/x.php']);

    expect(mockSftp.disconnect).toHaveBeenCalled();
  });
});

describe('UploadOrchestratorV2 — permissions', () => {
  let orchestrator: UploadOrchestratorV2;

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new UploadOrchestratorV2(mockSftp as any);
  });

  it('calls chmod after each successful upload when filePermissions is set', async () => {
    const serverWithPerms = { ...server, filePermissions: 0o644 };
    const items = [item('a.php'), item('b.php')];
    await orchestrator.upload(items, credential, serverWithPerms);

    expect(mockSftp.chmod).toHaveBeenCalledWith('/var/www/a.php', 0o644);
    expect(mockSftp.chmod).toHaveBeenCalledWith('/var/www/b.php', 0o644);
  });

  it('does not call chmod when filePermissions is not set', async () => {
    const items = [item('a.php')];
    await orchestrator.upload(items, credential, server);

    expect(mockSftp.chmod).not.toHaveBeenCalled();
  });

  it('does not call chmod for a failed upload', async () => {
    mockSftp.uploadFile.mockRejectedValueOnce(new Error('disk full'));
    const serverWithPerms = { ...server, filePermissions: 0o644 };
    const items = [item('a.php')];
    const result = await orchestrator.upload(items, credential, serverWithPerms);

    expect(result.failed).toHaveLength(1);
    expect(mockSftp.chmod).not.toHaveBeenCalled();
  });

  it('chmod failure does not prevent other uploads or cause the item to appear in failed', async () => {
    mockSftp.chmod.mockRejectedValueOnce(new Error('chmod not supported'));
    const serverWithPerms = { ...server, filePermissions: 0o644 };
    const items = [item('a.php'), item('b.php')];
    const result = await orchestrator.upload(items, credential, serverWithPerms);

    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(mockSftp.chmod).toHaveBeenCalledTimes(2);
  });
});

describe('UploadOrchestratorV2 — deploy hooks', () => {
  let orchestrator: UploadOrchestratorV2;
  // Records the order of key operations so we can assert hook timing.
  let callLog: string[];

  const hookContext = {
    workspaceRoot: '/workspace',
    dryRun: false,
    isTrusted: true,
    output: { appendLine: jest.fn() } as any,
  };

  function serverWithHooks(hooks: any): any {
    return { ...server, hooks };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new UploadOrchestratorV2(mockSftp as any);
    callLog = [];
    mockRunHooks.mockImplementation((options: { phase: string }) => {
      callLog.push(`hook:${options.phase}`);
      return Promise.resolve({ ok: true });
    });
    mockSftp.connect.mockImplementation(() => { callLog.push('connect'); return Promise.resolve(); });
    mockSftp.uploadFile.mockImplementation(() => { callLog.push('upload'); return Promise.resolve(); });
    mockSftp.disconnect.mockImplementation(() => { callLog.push('disconnect'); return Promise.resolve(); });
  });

  it('does not run hooks when no hookContext is given (the auto-upload path)', async () => {
    const hooks = { preDeploy: [{ command: 'build', location: 'local' }] };
    await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks));
    expect(mockRunHooks).not.toHaveBeenCalled();
  });

  it('does not run hooks when runHooks is false', async () => {
    const hooks = { preDeploy: [{ command: 'build', location: 'local' }] };
    await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, {
      ...hookContext,
      runHooks: false,
    });
    expect(mockRunHooks).not.toHaveBeenCalled();
  });

  it('runs a local pre-hook BEFORE connecting (with remote: null)', async () => {
    const hooks = { preDeploy: [{ command: 'npm run build', location: 'local' }] };
    await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, hookContext);

    expect(callLog.indexOf('hook:pre')).toBeLessThan(callLog.indexOf('connect'));
    expect(mockRunHooks).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'pre',
      remote: null,
      workspaceRoot: '/workspace',
    }));
  });

  it('runs a remote pre-hook AFTER connecting, using the connected service as remote', async () => {
    const hooks = { preDeploy: [{ command: 'php artisan down', location: 'remote' }] };
    await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, hookContext);

    expect(callLog.indexOf('connect')).toBeLessThan(callLog.indexOf('hook:pre'));
    expect(callLog.indexOf('hook:pre')).toBeLessThan(callLog.indexOf('upload'));
    expect(mockRunHooks).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'pre',
      remote: mockSftp,
    }));
  });

  it('aborts a local pre-hook failure before connecting or uploading', async () => {
    mockRunHooks.mockImplementation((options: { phase: string }) => {
      callLog.push(`hook:${options.phase}`);
      return Promise.resolve({ ok: false });
    });
    const hooks = { preDeploy: [{ command: 'npm test', location: 'local' }] };
    const result = await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, hookContext);

    expect(result.hookAborted).toBe(true);
    expect(mockSftp.connect).not.toHaveBeenCalled();
    expect(mockSftp.uploadFile).not.toHaveBeenCalled();
  });

  it('aborts a remote pre-hook failure before uploading but still disconnects', async () => {
    mockRunHooks.mockImplementation((options: { phase: string }) => {
      callLog.push(`hook:${options.phase}`);
      return Promise.resolve({ ok: false });
    });
    const hooks = { preDeploy: [{ command: 'php artisan down', location: 'remote' }] };
    const result = await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, hookContext);

    expect(result.hookAborted).toBe(true);
    expect(mockSftp.connect).toHaveBeenCalled();
    expect(mockSftp.uploadFile).not.toHaveBeenCalled();
    expect(mockSftp.disconnect).toHaveBeenCalled();
  });

  it('runs post-hooks after uploads and before disconnect', async () => {
    const hooks = { postDeploy: [{ command: 'systemctl reload nginx', location: 'remote' }] };
    await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, hookContext);

    expect(callLog.indexOf('upload')).toBeLessThan(callLog.indexOf('hook:post'));
    expect(callLog.indexOf('hook:post')).toBeLessThan(callLog.indexOf('disconnect'));
  });

  it('does not abort the deploy when a post-hook fails (files already uploaded)', async () => {
    mockRunHooks.mockResolvedValue({ ok: false });
    const hooks = { postDeploy: [{ command: 'reload', location: 'remote' }] };
    const result = await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, hookContext);

    expect(result.hookAborted).toBeUndefined();
    expect(result.succeeded).toHaveLength(1);
  });

  it('does NOT run post-hooks when every upload failed (nothing was transferred)', async () => {
    mockSftp.uploadFile.mockImplementation(() => { callLog.push('upload'); return Promise.reject(new Error('permission denied')); });
    const hooks = { postDeploy: [{ command: 'systemctl reload nginx', location: 'remote' }] };
    const result = await orchestrator.upload([item('a.php'), item('b.php')], credential, serverWithHooks(hooks), [], undefined, hookContext);

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    const postCalls = mockRunHooks.mock.calls.filter(c => c[0].phase === 'post');
    expect(postCalls).toHaveLength(0);
  });

  it('runs post-hooks for a deletes-only deploy when a delete succeeded', async () => {
    const hooks = { postDeploy: [{ command: 'systemctl reload nginx', location: 'remote' }] };
    await orchestrator.upload([], credential, serverWithHooks(hooks), ['/var/www/old.php'], undefined, hookContext);

    const postCalls = mockRunHooks.mock.calls.filter(c => c[0].phase === 'post');
    expect(postCalls).toHaveLength(1);
  });

  it('hands runHooks remote:null when the transport cannot exec (FTP)', async () => {
    // An FTP transport implements TransferService but NOT RemoteCommandRunner
    // (no execCommand), so canExec() is false and remote hooks must be skipped.
    const ftpTransfer = {
      connect: jest.fn().mockResolvedValue(undefined),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      chmod: jest.fn().mockResolvedValue(undefined),
    };
    const ftpOrchestrator = new UploadOrchestratorV2(ftpTransfer as any);
    const hooks = { postDeploy: [{ command: 'systemctl reload nginx', location: 'remote' }] };
    await ftpOrchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, hookContext);

    const postCall = mockRunHooks.mock.calls.find(c => c[0].phase === 'post');
    expect(postCall[0].remote).toBeNull();
  });

  describe('secret masking (#27b)', () => {
    it('hands runHooks a masking wrapper around the hook output, not the raw channel', async () => {
      const innerAppendLine = jest.fn();
      const context = { ...hookContext, output: { appendLine: innerAppendLine } as any };
      const hooks = { preDeploy: [{ command: 'deploy ${secret:API_TOKEN}', location: 'local' }] };

      await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, context);

      const options = mockRunHooks.mock.calls[0][0];
      expect(options.output).not.toBe(context.output);
      expect(typeof options.registerSecretValuesForMasking).toBe('function');

      // A value registered by the runner is masked on its way to the real channel.
      options.registerSecretValuesForMasking(['tok-secret-123']);
      options.output.appendLine('leaked tok-secret-123 here');
      expect(innerAppendLine).toHaveBeenCalledWith('leaked •••• here');
    });

    it('shares one masking channel across phases — a value resolved pre-deploy is still masked post-deploy', async () => {
      const innerAppendLine = jest.fn();
      const context = { ...hookContext, output: { appendLine: innerAppendLine } as any };
      const hooks = {
        preDeploy: [{ command: 'build ${secret:API_TOKEN}', location: 'local' }],
        postDeploy: [{ command: 'reload', location: 'remote' }],
      };

      await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, context);

      const preOptions = mockRunHooks.mock.calls.find(c => c[0].phase === 'pre')![0];
      const postOptions = mockRunHooks.mock.calls.find(c => c[0].phase === 'post')![0];
      expect(postOptions.output).toBe(preOptions.output);

      preOptions.registerSecretValuesForMasking(['tok-secret-123']);
      postOptions.output.appendLine('post says tok-secret-123');
      expect(innerAppendLine).toHaveBeenCalledWith('post says ••••');
    });
  });

  describe('secret pre-flight (#27b)', () => {
    const secretsSource = { get: jest.fn(), has: jest.fn().mockReturnValue(false) };
    const contextWithSecrets = { ...hookContext, secrets: secretsSource as any };

    beforeEach(() => {
      mockPreflight.mockReturnValue({ ok: true });
      mockPreflight.mockImplementation(() => { callLog.push('preflight'); return { ok: true }; });
    });

    it('aborts with hookAborted before connecting or transferring when the preflight fails', async () => {
      mockPreflight.mockImplementation(() => { callLog.push('preflight'); return { ok: false }; });
      const hooks = { postDeploy: [{ command: 'migrate ${secret:MISSING_TOKEN}', location: 'remote' }] };

      const result = await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, contextWithSecrets);

      expect(result.hookAborted).toBe(true);
      expect(result.succeeded).toHaveLength(0);
      expect(mockSftp.connect).not.toHaveBeenCalled();
      expect(mockSftp.uploadFile).not.toHaveBeenCalled();
      expect(mockRunHooks).not.toHaveBeenCalled();
    });

    it('runs the preflight before connecting, with all pre+post hooks and the secret source', async () => {
      const preHook = { command: 'build ${secret:A}', location: 'local' };
      const postHook = { command: 'migrate ${secret:B}', location: 'remote' };
      const hooks = { preDeploy: [preHook], postDeploy: [postHook] };

      await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, contextWithSecrets);

      expect(callLog.indexOf('preflight')).toBeLessThan(callLog.indexOf('connect'));
      expect(mockPreflight).toHaveBeenCalledWith(expect.objectContaining({
        preDeploy: [preHook],
        postDeploy: [postHook],
        secrets: secretsSource,
      }));
    });

    it('excludes remote hooks from the preflight when the transport cannot exec (FTP skips them anyway)', async () => {
      const ftpTransfer = {
        connect: jest.fn().mockResolvedValue(undefined),
        uploadFile: jest.fn().mockResolvedValue(undefined),
        deleteFile: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        chmod: jest.fn().mockResolvedValue(undefined),
      };
      const ftpOrchestrator = new UploadOrchestratorV2(ftpTransfer as any);
      const localHook = { command: 'build ${secret:A}', location: 'local' };
      const remoteHook = { command: 'migrate ${secret:B}', location: 'remote' };
      const hooks = { preDeploy: [localHook, remoteHook], postDeploy: [remoteHook] };

      await ftpOrchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, contextWithSecrets);

      expect(mockPreflight).toHaveBeenCalledWith(expect.objectContaining({
        preDeploy: [localHook],
        postDeploy: [],
      }));
    });

    it('skips the preflight on dry-run', async () => {
      const hooks = { preDeploy: [{ command: 'build ${secret:A}', location: 'local' }] };
      await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, {
        ...contextWithSecrets,
        dryRun: true,
      });
      expect(mockPreflight).not.toHaveBeenCalled();
    });

    it('skips the preflight in an untrusted workspace (hooks are skipped entirely there)', async () => {
      const hooks = { preDeploy: [{ command: 'build ${secret:A}', location: 'local' }] };
      await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, {
        ...contextWithSecrets,
        isTrusted: false,
      });
      expect(mockPreflight).not.toHaveBeenCalled();
    });

    it('skips the preflight when hooks are disabled or no hook context is given', async () => {
      const hooks = { preDeploy: [{ command: 'build ${secret:A}', location: 'local' }] };
      await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks), [], undefined, {
        ...contextWithSecrets,
        runHooks: false,
      });
      await orchestrator.upload([item('a.php')], credential, serverWithHooks(hooks));
      expect(mockPreflight).not.toHaveBeenCalled();
    });
  });
});
