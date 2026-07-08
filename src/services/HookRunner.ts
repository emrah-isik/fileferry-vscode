import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { CancellationToken, OutputChannel } from 'vscode';
import { RemoteCommandRunner } from '../transferService';
import { HookCommand, HookLocation } from '../models/ProjectConfig';
import {
  findSecretReferences,
  resolveLocalCommand,
  resolveRemoteCommand,
} from './hookSecretResolution';

// The data shape (command/location/continueOnError/timeoutMs) lives in the
// model, since it's persisted in fileferry.json. Re-exported here so callers of
// the runner don't have to reach into the model for it.
export type { HookCommand, HookLocation };

export type HookPhase = 'pre' | 'post';

// Where ${secret:NAME} values come from — HookSecretManager satisfies this.
// has() is an index lookup (no keychain read) so the preflight can check
// existence without touching values.
export interface HookSecretSource {
  get(name: string): Promise<string | undefined>;
  has(name: string): boolean;
}

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
  // Resolves ${secret:NAME} references. A command that references a secret
  // fails (never runs half-resolved) when this is absent or the name unknown.
  secrets?: HookSecretSource;
  // Called with each resolved value so the output channel can mask it (#27b
  // step 3). Masking only covers values FileFerry itself resolved.
  registerSecretValuesForMasking?: (values: string[]) => void;
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

    // Resolve ${secret:NAME} references — the last step before the command
    // runs. A hook whose references can't be fully resolved never runs at all.
    // The scan is synchronous so a token-free hook dispatches immediately —
    // the keychain is only consulted when a command actually references it.
    const scan = findSecretReferences(hook.command);
    let result: { ok: boolean; exitCode: number | null };
    if (scan.names.length === 0 && scan.invalidNames.length === 0) {
      result = hook.location === 'remote'
        ? await runRemoteCommand(hook, options, EMPTY_SECRET_VALUES)
        : await runLocalCommand(hook, options, EMPTY_SECRET_VALUES);
    } else {
      const resolution = await resolveSecretsForHook(scan, hook, options);
      if (resolution.ok) {
        result = hook.location === 'remote'
          ? await runRemoteCommand(hook, options, resolution.values)
          : await runLocalCommand(hook, options, resolution.values);
      } else {
        result = { ok: false, exitCode: null };
      }
    }

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

const EMPTY_SECRET_VALUES: ReadonlyMap<string, string> = new Map();

// Deploy-wide secret check, run by the orchestrator BEFORE anything is
// transferred (and before connecting). A missing or malformed ${secret:NAME}
// reference is knowable in advance — unlike a runtime hook failure — so a
// deploy that would end with a broken post-hook (files uploaded, migration
// never ran) is aborted up front instead. Existence only, via has(): values
// are still resolved per-hook at the last moment before each run.
//
// Hooks with continueOnError don't block — their failure is explicitly
// tolerated — but the problem is logged so the runtime failure isn't a
// surprise. The caller passes only hooks that will actually run (e.g. remote
// hooks are excluded on FTP, where they are skipped anyway).
export function preflightHookSecrets(options: {
  preDeploy: HookCommand[];
  postDeploy: HookCommand[];
  secrets?: HookSecretSource;
  output: OutputChannel;
}): { ok: boolean } {
  const { preDeploy, postDeploy, secrets, output } = options;
  let ok = true;

  const phases: Array<{ phase: HookPhase; hooks: HookCommand[] }> = [
    { phase: 'pre', hooks: preDeploy },
    { phase: 'post', hooks: postDeploy },
  ];

  for (const { phase, hooks } of phases) {
    for (const hook of hooks) {
      const scan = findSecretReferences(hook.command);

      const problems: string[] = [];
      if (scan.invalidNames.length > 0) {
        problems.push(
          `invalid secret reference(s) ${scan.invalidNames.map(name => `\${secret:${name}}`).join(', ')}`
        );
      }
      const missingNames = secrets
        ? scan.names.filter(name => !secrets.has(name))
        : scan.names;
      if (missingNames.length > 0) {
        problems.push(
          secrets
            ? `missing secret(s) ${missingNames.join(', ')} on this machine`
            : `secret(s) ${missingNames.join(', ')} referenced but no secret store is available`
        );
      }
      if (problems.length === 0) {
        continue;
      }

      if (hook.continueOnError) {
        output.appendLine(
          `${LOG_PREFIX}: warning — the ${phase}-deploy ${hook.location} hook has ${problems.join('; ')} ` +
          `and will fail when it runs (continueOnError is set, so the deploy proceeds): ${hook.command}`
        );
        continue;
      }

      ok = false;
      output.appendLine(
        `${LOG_PREFIX}: deploy aborted before any transfer — the ${phase}-deploy ${hook.location} hook has ` +
        `${problems.join('; ')}: ${hook.command} ` +
        'Add missing secrets under Deployment Settings → Hooks → Secrets (they are stored in the OS keychain, not shared via git).'
      );
    }
  }

  return { ok };
}

// Resolves the scanned ${secret:NAME} references against the secret source.
// Returns the values keyed by name; logs and fails (without running anything)
// on a malformed token, a missing store, or an unknown name.
async function resolveSecretsForHook(
  scan: ReturnType<typeof findSecretReferences>,
  hook: HookCommand,
  options: HookRunOptions
): Promise<{ ok: true; values: Map<string, string> } | { ok: false }> {
  const { output, secrets, registerSecretValuesForMasking } = options;

  if (scan.invalidNames.length > 0) {
    output.appendLine(
      `${LOG_PREFIX}: hook not run — invalid secret reference(s) ` +
      `${scan.invalidNames.map(name => `\${secret:${name}}`).join(', ')} ` +
      '(names use letters, digits and underscores, not starting with a digit).'
    );
    return { ok: false };
  }

  if (!secrets) {
    output.appendLine(
      `${LOG_PREFIX}: hook not run — the command references ${scan.names.join(', ')} but no secret store is available in this deploy.`
    );
    return { ok: false };
  }

  const values = new Map<string, string>();
  const missingNames: string[] = [];
  for (const name of scan.names) {
    const value = await secrets.get(name);
    if (value === undefined) {
      missingNames.push(name);
    } else {
      values.set(name, value);
    }
  }

  if (missingNames.length > 0) {
    output.appendLine(
      `${LOG_PREFIX}: hook not run — missing secret(s) ${missingNames.join(', ')} on this machine. ` +
      'Add them under Deployment Settings → Hooks → Secrets (secrets are stored in the OS keychain and not shared via git).'
    );
    return { ok: false };
  }

  registerSecretValuesForMasking?.([...values.values()]);
  return { ok: true, values };
}

// Runs a remote hook over the deploy's own SSH connection. Failure is the exit
// code alone: non-zero (or null from a signal/timeout) fails; exit 0 succeeds
// even when stderr is non-empty — that stderr is logged for visibility only.
async function runRemoteCommand(
  hook: HookCommand,
  options: HookRunOptions,
  secretValues: ReadonlyMap<string, string>
): Promise<{ ok: boolean; exitCode: number | null }> {
  const { remote, output } = options;

  if (!remote) {
    output.appendLine(
      `${LOG_PREFIX}: remote hook skipped — this server is FTP, not SFTP (remote commands need an SSH connection): ${hook.command}`
    );
    return { ok: true, exitCode: 0 };
  }

  // Secrets are inlined into the string sent over SSH (sshd's AcceptEnv is
  // usually too restrictive for env injection). The resolved string is passed
  // to exec and NEVER logged — every log line uses hook.command instead.
  const result = await remote.execCommand(
    resolveRemoteCommand(hook.command, secretValues),
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
  options: HookRunOptions,
  secretValues: ReadonlyMap<string, string>
): Promise<{ ok: boolean; exitCode: number | null }> {
  const { workspaceRoot, output, token } = options;

  return new Promise(resolve => {
    // Node's spawn `shell` option accepts a shell PATH and maps the invocation
    // switch itself (`-c` for POSIX, `/d /s /c` for cmd.exe). Passing
    // vscode.env.shell honours the user's real shell (Git Bash / pwsh / WSL);
    // `true` falls back to Node's platform default when it's unset. Bare
    // `shell: true` would resolve to cmd.exe on Windows and break bash-isms.
    const shell: string | boolean = vscode.env.shell || true;

    // Secrets ride in the environment, not the string: each ${secret:NAME}
    // token is rewritten to the shell's own variable reference ($NAME /
    // %NAME% / $env:NAME) and the value is injected via the env overlay, so
    // the command string never contains it. Logs keep showing hook.command.
    const resolved = resolveLocalCommand(hook.command, secretValues, shell);
    const environment = secretValues.size > 0
      ? { ...process.env, ...resolved.environmentOverlay }
      : process.env;

    const child = spawn(resolved.command, {
      cwd: workspaceRoot,
      shell,
      env: environment,
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
