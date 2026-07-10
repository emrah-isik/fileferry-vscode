import { EventEmitter } from 'events';

jest.mock('child_process');

import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { runHooks, preflightHookSecrets, HookCommand, HookRunOptions } from '../../services/HookRunner';
import { SecretMaskingOutputChannel } from '../../services/SecretMaskingOutputChannel';
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

  describe('${secret:} resolution', () => {
    // A secret source seeded like a real HookSecretManager would be.
    function makeSecrets(fixtures: Record<string, string>) {
      return {
        get: jest.fn(async (name: string) => fixtures[name]),
        has: jest.fn((name: string) => name in fixtures),
      };
    }

    // Secret resolution is async, so tests can't emit 'close' synchronously
    // after calling runHooks — instead every spawned child closes itself on
    // the next tick, whenever the spawn actually happens.
    function makeAutoClosingSpawn(exitCode = 0): void {
      mockSpawn.mockImplementation(() => {
        const child = makeChild();
        process.nextTick(() => child.emit('close', exitCode));
        return child;
      });
    }

    describe('local hooks', () => {
      it('injects the value as an environment variable and keeps it out of the command string', async () => {
        (vscode.env as { shell?: string }).shell = '/bin/bash';
        makeAutoClosingSpawn();
        const output = makeOutput();
        const secrets = makeSecrets({ API_TOKEN: 'tok-secret-123' });
        const hooks: HookCommand[] = [{
          command: 'curl -H "Authorization: Bearer ${secret:API_TOKEN}" https://api.example.com',
          location: 'local',
        }];

        const result = await runHooks(baseOptions({ hooks, secrets, output: output as unknown as HookRunOptions['output'] }));

        expect(result.ok).toBe(true);
        const [spawnedCommand, spawnOptions] = mockSpawn.mock.calls[0];
        expect(spawnedCommand).toBe('curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com');
        expect(spawnedCommand).not.toContain('tok-secret-123');
        expect(spawnOptions.env).toEqual(expect.objectContaining({ API_TOKEN: 'tok-secret-123' }));
        // The overlay merges over process.env, it does not replace it.
        expect(Object.keys(spawnOptions.env)).toEqual(expect.arrayContaining(Object.keys(process.env)));
      });

      it('never writes the resolved value to the output channel — logs show the unresolved token', async () => {
        (vscode.env as { shell?: string }).shell = '/bin/bash';
        makeAutoClosingSpawn();
        const output = makeOutput();
        const secrets = makeSecrets({ API_TOKEN: 'tok-secret-123' });
        const hooks: HookCommand[] = [{ command: 'deploy ${secret:API_TOKEN}', location: 'local' }];

        await runHooks(baseOptions({ hooks, secrets, output: output as unknown as HookRunOptions['output'] }));

        const text = output.lines.join('\n');
        expect(text).toContain('${secret:API_TOKEN}');
        expect(text).not.toContain('tok-secret-123');
      });

      it('does not touch the spawn environment for a command without tokens', async () => {
        makeAutoClosingSpawn();
        const secrets = makeSecrets({ API_TOKEN: 'tok-secret-123' });
        const hooks: HookCommand[] = [{ command: 'npm run build', location: 'local' }];

        await runHooks(baseOptions({ hooks, secrets }));

        expect(mockSpawn.mock.calls[0][0]).toBe('npm run build');
        expect(mockSpawn.mock.calls[0][1].env).toBe(process.env);
        expect(secrets.get).not.toHaveBeenCalled();
      });
    });

    describe('remote hooks', () => {
      it('inlines the value into the command sent over SSH but never logs the resolved string', async () => {
        const remote = makeRemote({ stdout: '', stderr: '', exitCode: 0 });
        const output = makeOutput();
        const secrets = makeSecrets({ DB_PASS: 'hunter2' });
        const hooks: HookCommand[] = [{
          command: 'mysqldump -u root -p${secret:DB_PASS} app',
          location: 'remote',
        }];

        const result = await runHooks(baseOptions({ hooks, remote, secrets, output: output as unknown as HookRunOptions['output'] }));

        expect(result.ok).toBe(true);
        expect(remote.execCommand).toHaveBeenCalledWith('mysqldump -u root -phunter2 app', undefined);
        const text = output.lines.join('\n');
        expect(text).toContain('${secret:DB_PASS}');
        expect(text).not.toContain('hunter2');
      });
    });

    describe('failure modes', () => {
      it('fails the hook without running it when a referenced secret is not stored, naming the secret', async () => {
        const output = makeOutput();
        const secrets = makeSecrets({});
        const hooks: HookCommand[] = [{ command: 'deploy ${secret:MISSING_TOKEN}', location: 'local' }];

        const result = await runHooks(baseOptions({ hooks, secrets, output: output as unknown as HookRunOptions['output'] }));

        expect(result.ok).toBe(false);
        expect(mockSpawn).not.toHaveBeenCalled();
        const text = output.lines.join('\n');
        expect(text).toContain('MISSING_TOKEN');
        expect(text).toMatch(/secrets/i);
      });

      it('fails a remote hook the same way — the half-resolved command never reaches the server', async () => {
        const remote = makeRemote({ stdout: '', stderr: '', exitCode: 0 });
        const secrets = makeSecrets({});
        const hooks: HookCommand[] = [{ command: 'deploy ${secret:MISSING_TOKEN}', location: 'remote' }];

        const result = await runHooks(baseOptions({ hooks, remote, secrets }));

        expect(result.ok).toBe(false);
        expect(remote.execCommand).not.toHaveBeenCalled();
      });

      it('respects continueOnError for a missing secret', async () => {
        makeAutoClosingSpawn();
        const secrets = makeSecrets({});
        const hooks: HookCommand[] = [
          { command: 'deploy ${secret:MISSING_TOKEN}', location: 'local', continueOnError: true },
          { command: 'runs-anyway', location: 'local' },
        ];

        const result = await runHooks(baseOptions({ hooks, secrets }));

        expect(result.ok).toBe(true);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(mockSpawn).toHaveBeenCalledWith('runs-anyway', expect.anything());
      });

      it('fails when a command references a secret but no secret store was provided', async () => {
        const output = makeOutput();
        const hooks: HookCommand[] = [{ command: 'deploy ${secret:API_TOKEN}', location: 'local' }];

        const result = await runHooks(baseOptions({ hooks, output: output as unknown as HookRunOptions['output'] }));

        expect(result.ok).toBe(false);
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(output.lines.join('\n')).toContain('API_TOKEN');
      });

      it('fails on a malformed secret token instead of running it literally', async () => {
        const output = makeOutput();
        const secrets = makeSecrets({});
        const hooks: HookCommand[] = [{ command: 'deploy ${secret:BAD-NAME}', location: 'local' }];

        const result = await runHooks(baseOptions({ hooks, secrets, output: output as unknown as HookRunOptions['output'] }));

        expect(result.ok).toBe(false);
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(output.lines.join('\n')).toContain('BAD-NAME');
      });
    });

    describe('masking hook', () => {
      it('reports each resolved value so the output channel can mask it', async () => {
        (vscode.env as { shell?: string }).shell = '/bin/bash';
        makeAutoClosingSpawn();
        const registerSecretValuesForMasking = jest.fn();
        const secrets = makeSecrets({ API_TOKEN: 'tok-secret-123', DB_PASS: 'hunter2' });
        const hooks: HookCommand[] = [{
          command: 'deploy ${secret:API_TOKEN} ${secret:DB_PASS}',
          location: 'local',
        }];

        await runHooks(baseOptions({ hooks, secrets, registerSecretValuesForMasking }));

        expect(registerSecretValuesForMasking).toHaveBeenCalledWith(['tok-secret-123', 'hunter2']);
      });

      // End-to-end through a real masking channel: even when the hook itself
      // prints the resolved value, the output channel shows ••••.
      it('masks a resolved value that the hook prints to stdout', async () => {
        (vscode.env as { shell?: string }).shell = '/bin/bash';
        mockSpawn.mockImplementation(() => {
          const child = makeChild();
          process.nextTick(() => {
            child.stdout.emit('data', Buffer.from('the token is tok-secret-123\n'));
            child.emit('close', 0);
          });
          return child;
        });
        const output = makeOutput();
        const maskingChannel = new SecretMaskingOutputChannel(output as any);
        const secrets = makeSecrets({ API_TOKEN: 'tok-secret-123' });
        const hooks: HookCommand[] = [{ command: 'print-token ${secret:API_TOKEN}', location: 'local' }];

        await runHooks(baseOptions({
          hooks,
          secrets,
          output: maskingChannel as unknown as HookRunOptions['output'],
          registerSecretValuesForMasking: values => maskingChannel.registerSecretValues(values),
        }));

        const text = output.lines.join('\n');
        expect(text).toContain('the token is ••••');
        expect(text).not.toContain('tok-secret-123');
      });
    });

    describe('preflightHookSecrets (deploy-wide check before any transfer)', () => {
      function makeSecretsSource(storedNames: string[]) {
        return {
          get: jest.fn(async () => { throw new Error('preflight must not read values'); }),
          has: jest.fn((name: string) => storedNames.includes(name)),
        };
      }

      it('passes for hooks without secret tokens, logging nothing', () => {
        const output = makeOutput();
        const result = preflightHookSecrets({
          preDeploy: [{ command: 'npm run build', location: 'local' }],
          postDeploy: [{ command: 'systemctl reload nginx', location: 'remote' }],
          secrets: makeSecretsSource([]),
          output: output as unknown as HookRunOptions['output'],
        });
        expect(result.ok).toBe(true);
        expect(output.appendLine).not.toHaveBeenCalled();
      });

      it('passes when every referenced secret exists — checking existence only, never reading values', () => {
        const secrets = makeSecretsSource(['API_TOKEN', 'DB_PASS']);
        const result = preflightHookSecrets({
          preDeploy: [{ command: 'build ${secret:API_TOKEN}', location: 'local' }],
          postDeploy: [{ command: 'migrate ${secret:DB_PASS}', location: 'remote' }],
          secrets,
          output: makeOutput() as unknown as HookRunOptions['output'],
        });
        expect(result.ok).toBe(true);
        expect(secrets.has).toHaveBeenCalledWith('API_TOKEN');
        expect(secrets.has).toHaveBeenCalledWith('DB_PASS');
        expect(secrets.get).not.toHaveBeenCalled();
      });

      it('fails when a pre-deploy hook references a missing secret, naming it', () => {
        const output = makeOutput();
        const result = preflightHookSecrets({
          preDeploy: [{ command: 'build ${secret:MISSING_TOKEN}', location: 'local' }],
          postDeploy: [],
          secrets: makeSecretsSource([]),
          output: output as unknown as HookRunOptions['output'],
        });
        expect(result.ok).toBe(false);
        const text = output.lines.join('\n');
        expect(text).toContain('MISSING_TOKEN');
        expect(text).toMatch(/before any transfer/i);
        expect(text).toMatch(/secrets/i);
      });

      // The reason preflight exists: a POST-deploy hook with a missing secret
      // must abort the deploy BEFORE files are uploaded, not fail after — a
      // missing secret is knowable in advance, unlike a runtime hook failure.
      it('fails for a missing secret in a post-deploy hook', () => {
        const result = preflightHookSecrets({
          preDeploy: [],
          postDeploy: [{ command: 'migrate ${secret:MISSING_TOKEN}', location: 'remote' }],
          secrets: makeSecretsSource([]),
          output: makeOutput() as unknown as HookRunOptions['output'],
        });
        expect(result.ok).toBe(false);
      });

      it('fails on a malformed secret token', () => {
        const output = makeOutput();
        const result = preflightHookSecrets({
          preDeploy: [{ command: 'deploy ${secret:BAD-NAME}', location: 'local' }],
          postDeploy: [],
          secrets: makeSecretsSource([]),
          output: output as unknown as HookRunOptions['output'],
        });
        expect(result.ok).toBe(false);
        expect(output.lines.join('\n')).toContain('BAD-NAME');
      });

      it('fails when a command references a secret but no secret store is available', () => {
        const result = preflightHookSecrets({
          preDeploy: [{ command: 'deploy ${secret:API_TOKEN}', location: 'local' }],
          postDeploy: [],
          output: makeOutput() as unknown as HookRunOptions['output'],
        });
        expect(result.ok).toBe(false);
      });

      // continueOnError means "this hook's failure is tolerated" — so its
      // missing secret must not block the deploy; it fails at run time as
      // usual. Preflight still surfaces a warning so the user isn't surprised.
      it('does not block for a continueOnError hook, but logs a warning', () => {
        const output = makeOutput();
        const result = preflightHookSecrets({
          preDeploy: [{ command: 'notify ${secret:MISSING_TOKEN}', location: 'local', continueOnError: true }],
          postDeploy: [],
          secrets: makeSecretsSource([]),
          output: output as unknown as HookRunOptions['output'],
        });
        expect(result.ok).toBe(true);
        const text = output.lines.join('\n');
        expect(text).toContain('MISSING_TOKEN');
        expect(text).toMatch(/continueOnError|continue on error/i);
      });

      it('reports every problem hook, not just the first', () => {
        const output = makeOutput();
        const result = preflightHookSecrets({
          preDeploy: [{ command: 'build ${secret:FIRST_MISSING}', location: 'local' }],
          postDeploy: [{ command: 'migrate ${secret:SECOND_MISSING}', location: 'remote' }],
          secrets: makeSecretsSource([]),
          output: output as unknown as HookRunOptions['output'],
        });
        expect(result.ok).toBe(false);
        const text = output.lines.join('\n');
        expect(text).toContain('FIRST_MISSING');
        expect(text).toContain('SECOND_MISSING');
      });
    });

    describe('dry run', () => {
      it('does not read the keychain and logs the unresolved token', async () => {
        const output = makeOutput();
        const secrets = makeSecrets({ API_TOKEN: 'tok-secret-123' });
        const hooks: HookCommand[] = [{ command: 'deploy ${secret:API_TOKEN}', location: 'local' }];

        const result = await runHooks(baseOptions({
          hooks, secrets, dryRun: true, output: output as unknown as HookRunOptions['output'],
        }));

        expect(result.ok).toBe(true);
        expect(secrets.get).not.toHaveBeenCalled();
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(output.lines.join('\n')).toContain('${secret:API_TOKEN}');
      });
    });
  });
});
