import { EventEmitter } from 'events';

jest.mock('child_process');

import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { runHooks, HookCommand, HookRunOptions } from '../../services/HookRunner';
import { RemoteCommandRunner, RemoteCommandResult } from '../../transferService';

const mockSpawn = child_process.spawn as unknown as jest.Mock;

// A fake child_process.ChildProcess: an EventEmitter ('close'/'error') that also
// carries stdout/stderr EventEmitters and a kill() spy.
type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: jest.Mock };
function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

// A fake output channel that records appended lines.
function makeOutput(): { appendLine: jest.Mock; lines: string[] } {
  const lines: string[] = [];
  return { appendLine: jest.fn((line: string) => { lines.push(line); }), lines };
}

// A RemoteCommandRunner whose execCommand resolves to a configurable result.
function makeRemote(result: RemoteCommandResult): RemoteCommandRunner & { execCommand: jest.Mock } {
  return { execCommand: jest.fn().mockResolvedValue(result) };
}

function baseOptions(overrides: Partial<HookRunOptions>): HookRunOptions {
  return {
    phase: 'pre',
    hooks: [],
    workspaceRoot: '/home/user/project',
    remote: null,
    dryRun: false,
    isTrusted: true,
    output: makeOutput() as unknown as HookRunOptions['output'],
    ...overrides,
  };
}

describe('runHooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.env as { shell?: string }).shell = undefined;
  });

  describe('local hooks', () => {
    it('spawns the command with cwd = workspace root and resolves ok on exit 0', async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const output = makeOutput();
      const hooks: HookCommand[] = [{ command: 'npm run build', location: 'local' }];

      const promise = runHooks(baseOptions({ hooks, output: output as unknown as HookRunOptions['output'] }));
      child.stdout.emit('data', Buffer.from('build done\n'));
      child.emit('close', 0);
      const result = await promise;

      expect(mockSpawn).toHaveBeenCalledWith('npm run build', expect.objectContaining({
        cwd: '/home/user/project',
      }));
      expect(result.ok).toBe(true);
      expect(output.lines.join('\n')).toContain('build done');
    });

    it('returns ok:false when a local command exits non-zero', async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const hooks: HookCommand[] = [{ command: 'npm test', location: 'local' }];

      const promise = runHooks(baseOptions({ hooks }));
      child.emit('close', 1);
      const result = await promise;

      expect(result.ok).toBe(false);
    });

    it('returns ok:false when the process emits a spawn error', async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const hooks: HookCommand[] = [{ command: 'missing-binary', location: 'local' }];

      const promise = runHooks(baseOptions({ hooks }));
      child.emit('error', new Error('spawn ENOENT'));
      const result = await promise;

      expect(result.ok).toBe(false);
    });
  });

  describe('local shell selection', () => {
    it('passes vscode.env.shell as the spawn shell option when set', async () => {
      (vscode.env as { shell?: string }).shell = '/usr/bin/zsh';
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const hooks: HookCommand[] = [{ command: 'echo hi', location: 'local' }];

      const promise = runHooks(baseOptions({ hooks }));
      child.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('echo hi', expect.objectContaining({ shell: '/usr/bin/zsh' }));
    });

    it('passes shell:true when vscode.env.shell is unset (Node picks the platform default)', async () => {
      (vscode.env as { shell?: string }).shell = undefined;
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const hooks: HookCommand[] = [{ command: 'echo hi', location: 'local' }];

      const promise = runHooks(baseOptions({ hooks }));
      child.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('echo hi', expect.objectContaining({ shell: true }));
    });
  });

  describe('remote hooks', () => {
    it('calls execCommand and resolves ok on exitCode 0', async () => {
      const remote = makeRemote({ stdout: 'reloaded\n', stderr: '', exitCode: 0 });
      const hooks: HookCommand[] = [{ command: 'systemctl reload nginx', location: 'remote' }];

      const result = await runHooks(baseOptions({ hooks, remote }));

      expect(remote.execCommand).toHaveBeenCalledWith('systemctl reload nginx', undefined);
      expect(result.ok).toBe(true);
    });

    it('returns ok:false on a non-zero remote exitCode', async () => {
      const remote = makeRemote({ stdout: '', stderr: 'migration failed\n', exitCode: 1 });
      const hooks: HookCommand[] = [{ command: 'php artisan migrate --force', location: 'remote' }];

      const result = await runHooks(baseOptions({ hooks, remote }));

      expect(result.ok).toBe(false);
    });

    it('returns ok:false on a null remote exitCode (signal / no exit reported)', async () => {
      const remote = makeRemote({ stdout: '', stderr: '', exitCode: null });
      const hooks: HookCommand[] = [{ command: 'long-running', location: 'remote' }];

      const result = await runHooks(baseOptions({ hooks, remote }));

      expect(result.ok).toBe(false);
    });

    // The defining invariant carried up from execCommand: a 0 exit with noisy
    // stderr (MOTD/banners/locale warnings) is a SUCCESS — the deploy proceeds
    // and the stderr is logged for visibility, never used as the failure trigger.
    it('treats exitCode 0 with non-empty stderr as success and logs the stderr', async () => {
      const remote = makeRemote({ stdout: '', stderr: 'Welcome to Ubuntu\nstty: Inaccessible\n', exitCode: 0 });
      const output = makeOutput();
      const hooks: HookCommand[] = [{ command: 'whoami', location: 'remote' }];

      const result = await runHooks(baseOptions({ hooks, remote, output: output as unknown as HookRunOptions['output'] }));

      expect(result.ok).toBe(true);
      expect(output.lines.join('\n')).toContain('Welcome to Ubuntu');
    });

    it('skips a remote hook with a warning (not a failure) when no remote runner is available (FTP)', async () => {
      const output = makeOutput();
      const hooks: HookCommand[] = [{ command: 'systemctl reload nginx', location: 'remote' }];

      const result = await runHooks(baseOptions({ hooks, remote: null, output: output as unknown as HookRunOptions['output'] }));

      expect(result.ok).toBe(true);
      expect(output.lines.join('\n')).toMatch(/remote hook skipped.*FTP/i);
    });

    it('passes the per-hook timeout to execCommand', async () => {
      const remote = makeRemote({ stdout: '', stderr: '', exitCode: 0 });
      const hooks: HookCommand[] = [{ command: 'deploy.sh', location: 'remote', timeoutMs: 30000 }];

      await runHooks(baseOptions({ hooks, remote }));

      expect(remote.execCommand).toHaveBeenCalledWith('deploy.sh', { timeoutMs: 30000 });
    });
  });

  describe('ordering', () => {
    it('runs the hooks in the order given', async () => {
      const calls: string[] = [];
      mockSpawn.mockImplementation((command: string) => {
        calls.push(command);
        const child = makeChild();
        process.nextTick(() => child.emit('close', 0));
        return child;
      });
      const hooks: HookCommand[] = [
        { command: 'first', location: 'local' },
        { command: 'second', location: 'local' },
        { command: 'third', location: 'local' },
      ];

      await runHooks(baseOptions({ hooks }));

      expect(calls).toEqual(['first', 'second', 'third']);
    });
  });

  describe('continueOnError', () => {
    it('logs a failure but keeps going and returns ok:true when the failing hook opts in', async () => {
      const remote = makeRemote({ stdout: '', stderr: 'boom\n', exitCode: 2 });
      const output = makeOutput();
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const hooks: HookCommand[] = [
        { command: 'flaky-remote', location: 'remote', continueOnError: true },
        { command: 'local-after', location: 'local' },
      ];

      const promise = runHooks(baseOptions({ hooks, remote, output: output as unknown as HookRunOptions['output'] }));
      // First hook is remote (awaits execCommand); once it settles the local one spawns.
      await Promise.resolve();
      await Promise.resolve();
      child.emit('close', 0);
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('local-after', expect.anything());
    });

    it('stops at the first hard failure (no continueOnError) and returns ok:false', async () => {
      const remote = makeRemote({ stdout: '', stderr: '', exitCode: 1 });
      const hooks: HookCommand[] = [
        { command: 'hard-fail', location: 'remote' },
        { command: 'should-not-run', location: 'local' },
      ];

      const result = await runHooks(baseOptions({ hooks, remote }));

      expect(result.ok).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('trust gate', () => {
    it('runs nothing in an untrusted workspace and reports the skip', async () => {
      const remote = makeRemote({ stdout: '', stderr: '', exitCode: 0 });
      const output = makeOutput();
      const hooks: HookCommand[] = [
        { command: 'npm run build', location: 'local' },
        { command: 'systemctl reload nginx', location: 'remote' },
      ];

      const result = await runHooks(baseOptions({
        hooks, remote, isTrusted: false, output: output as unknown as HookRunOptions['output'],
      }));

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(remote.execCommand).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(output.lines.join('\n')).toMatch(/not trusted|untrusted/i);
    });
  });

  describe('dry run', () => {
    it('logs each command and executes nothing', async () => {
      const remote = makeRemote({ stdout: '', stderr: '', exitCode: 0 });
      const output = makeOutput();
      const hooks: HookCommand[] = [
        { command: 'npm run build', location: 'local' },
        { command: 'systemctl reload nginx', location: 'remote' },
      ];

      const result = await runHooks(baseOptions({
        hooks, remote, dryRun: true, output: output as unknown as HookRunOptions['output'],
      }));

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(remote.execCommand).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      const text = output.lines.join('\n');
      expect(text).toMatch(/dry-run/i);
      expect(text).toContain('npm run build');
      expect(text).toContain('systemctl reload nginx');
    });
  });

  describe('timeout', () => {
    it('kills a hung local process and returns ok:false', async () => {
      jest.useFakeTimers();
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const hooks: HookCommand[] = [{ command: 'sleep 999', location: 'local', timeoutMs: 5000 }];

      const promise = runHooks(baseOptions({ hooks }));
      jest.advanceTimersByTime(5000);
      const result = await promise;

      expect(child.kill).toHaveBeenCalled();
      expect(result.ok).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('cancellation', () => {
    it('launches no hooks when the token is already cancelled', async () => {
      const remote = makeRemote({ stdout: '', stderr: '', exitCode: 0 });
      const token = { isCancellationRequested: true, onCancellationRequested: jest.fn() };
      const hooks: HookCommand[] = [
        { command: 'npm run build', location: 'local' },
        { command: 'systemctl reload nginx', location: 'remote' },
      ];

      await runHooks(baseOptions({
        hooks, remote, token: token as unknown as HookRunOptions['token'],
      }));

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(remote.execCommand).not.toHaveBeenCalled();
    });
  });

  describe('empty / no-op', () => {
    it('returns ok:true with no hooks and logs nothing', async () => {
      const output = makeOutput();
      const result = await runHooks(baseOptions({ hooks: [], output: output as unknown as HookRunOptions['output'] }));
      expect(result.ok).toBe(true);
      expect(output.appendLine).not.toHaveBeenCalled();
    });
  });
});
