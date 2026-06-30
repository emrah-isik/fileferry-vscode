import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { CancellationToken, OutputChannel } from 'vscode';
import { RemoteCommandRunner } from '../transferService';
import { HookCommand, HookLocation } from '../models/ProjectConfig';

// The data shape (command/location/continueOnError/timeoutMs) lives in the
// model, since it's persisted in fileferry.json. Re-exported here so callers of
// the runner don't have to reach into the model for it.
export type { HookCommand, HookLocation };

export type HookPhase = 'pre' | 'post';

export interface HookRunOptions {
  phase: HookPhase;
  // Hooks for this pass, already filtered by location/phase by the caller and in
  // the order they should run. runHooks dispatches each by its own `location`.
  hooks: HookCommand[];
  workspaceRoot: string;       // cwd for local commands
  remote: RemoteCommandRunner | null;  // null when the active transfer can't exec (FTP)
  dryRun: boolean;
  isTrusted: boolean;
  output: OutputChannel;
  token?: CancellationToken;
}

const LOG_PREFIX = 'FileFerry (hooks)';

// Runs the phase's hooks in order. Returns ok=false if a hook that did NOT opt
// into continueOnError failed; the caller aborts the deploy when phase==='pre'.
// A failure is a non-zero/null exit code, a spawn error, or a timeout — never
// the mere presence of stderr (servers leak MOTD/banner noise to stderr on a
// successful exit 0, and aborting on that would be wrong).
export async function runHooks(options: HookRunOptions): Promise<{ ok: boolean }> {
  const { hooks, output, isTrusted, dryRun, phase, token } = options;

  if (hooks.length === 0) {
    return { ok: true };
  }

  // Guard 1: Workspace Trust. Hooks are a code-execution surface, so they never
  // run in an untrusted workspace — the deploy proceeds without them.
  if (!isTrusted) {
    output.appendLine(
      `${LOG_PREFIX}: ${hooks.length} ${phase}-deploy hook(s) skipped — this workspace is not trusted. ` +
      'Trust this folder (Workspace Trust) to enable deploy hooks.'
    );
    return { ok: true };
  }

  for (const hook of hooks) {
    // Cancellation stops launching further hooks; an in-flight local process is
    // killed inside runLocalCommand via the token.
    if (token?.isCancellationRequested) {
      output.appendLine(`${LOG_PREFIX}: cancelled — skipping remaining ${phase}-deploy hooks.`);
      break;
    }

    if (dryRun) {
      output.appendLine(`${LOG_PREFIX} [dry-run]: would run (${hook.location}): ${hook.command}`);
      continue;
    }

    output.appendLine(`${LOG_PREFIX}: running ${phase}-deploy ${hook.location} hook: ${hook.command}`);

    const result = hook.location === 'remote'
      ? await runRemoteCommand(hook, options)
      : await runLocalCommand(hook, options);

    if (result.ok) {
      continue;
    }

    // The hook failed. continueOnError downgrades it to a logged warning;
    // otherwise it's a hard stop and the caller decides what to do.
    if (hook.continueOnError) {
      output.appendLine(
        `${LOG_PREFIX}: ${phase}-deploy hook failed (exit ${result.exitCode}) but continueOnError is set — continuing: ${hook.command}`
      );
      continue;
    }

    output.appendLine(`${LOG_PREFIX}: ${phase}-deploy hook failed (exit ${result.exitCode}): ${hook.command}`);
    return { ok: false };
  }

  return { ok: true };
}

// Runs a remote hook over the deploy's own SSH connection. Failure is the exit
// code alone: non-zero (or null from a signal/timeout) fails; exit 0 succeeds
// even when stderr is non-empty — that stderr is logged for visibility only.
async function runRemoteCommand(
  hook: HookCommand,
  options: HookRunOptions
): Promise<{ ok: boolean; exitCode: number | null }> {
  const { remote, output } = options;

  if (!remote) {
    output.appendLine(
      `${LOG_PREFIX}: remote hook skipped — this server is FTP, not SFTP (remote commands need an SSH connection): ${hook.command}`
    );
    return { ok: true, exitCode: 0 };
  }

  const result = await remote.execCommand(
    hook.command,
    hook.timeoutMs ? { timeoutMs: hook.timeoutMs } : undefined
  );

  if (result.stdout.trim()) {
    output.appendLine(`${LOG_PREFIX}: [remote stdout] ${result.stdout.trimEnd()}`);
  }
  if (result.stderr.trim()) {
    // Logged for visibility — NOT a failure trigger (could be MOTD/banner noise).
    output.appendLine(`${LOG_PREFIX}: [remote stderr] ${result.stderr.trimEnd()}`);
  }

  return { ok: result.exitCode === 0, exitCode: result.exitCode };
}

// Runs a local hook through the user's shell so free-form command strings
// (pipes, `&&`-chains, `$VAR`) work. Inherits process.env so users can keep
// secrets in their environment / a git-ignored .env rather than the config.
function runLocalCommand(
  hook: HookCommand,
  options: HookRunOptions
): Promise<{ ok: boolean; exitCode: number | null }> {
  const { workspaceRoot, output, token } = options;

  return new Promise(resolve => {
    // Node's spawn `shell` option accepts a shell PATH and maps the invocation
    // switch itself (`-c` for POSIX, `/d /s /c` for cmd.exe). Passing
    // vscode.env.shell honours the user's real shell (Git Bash / pwsh / WSL);
    // `true` falls back to Node's platform default when it's unset. Bare
    // `shell: true` would resolve to cmd.exe on Windows and break bash-isms.
    const shell: string | boolean = vscode.env.shell || true;

    const child = spawn(hook.command, {
      cwd: workspaceRoot,
      shell,
      env: process.env,
    });

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: { ok: boolean; exitCode: number | null }): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      cancelSubscription?.dispose();
      resolve(outcome);
    };

    // If the deploy is cancelled mid-command, kill the in-flight process.
    const cancelSubscription = token?.onCancellationRequested(() => {
      child.kill();
      finish({ ok: false, exitCode: null });
    });

    if (hook.timeoutMs && hook.timeoutMs > 0) {
      timer = setTimeout(() => {
        output.appendLine(`${LOG_PREFIX}: local hook timed out after ${hook.timeoutMs}ms, killing: ${hook.command}`);
        child.kill();
        finish({ ok: false, exitCode: null });
      }, hook.timeoutMs);
    }

    child.stdout?.on('data', (data: Buffer) => {
      output.appendLine(`${LOG_PREFIX}: [local stdout] ${data.toString().trimEnd()}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      output.appendLine(`${LOG_PREFIX}: [local stderr] ${data.toString().trimEnd()}`);
    });

    child.on('error', (error: Error) => {
      output.appendLine(`${LOG_PREFIX}: local hook failed to start: ${error.message}`);
      finish({ ok: false, exitCode: null });
    });

    child.on('close', (code: number | null) => {
      finish({ ok: code === 0, exitCode: code });
    });
  });
}
