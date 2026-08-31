import type { AuthMethod } from '../types';

/**
 * SSH connect providers — the UI-free contract every SSH connect goes through.
 *
 * This module must stay free of `vscode` imports: `SftpService` (and, from
 * 18a-2a on, the jump-host chain) reads the registry, and both are unit-tested
 * without a VS Code host. The VS Code implementations live in
 * `vscodeConnectProviders.ts` and are registered once from `extension.ts`.
 */

export interface KeyboardInteractivePrompt {
  prompt: string;
  echo: boolean;
}

export interface ConnectTarget {
  username: string;
  host: string;
  port: number;
}

/** Lets a provider tell the connect it now shows UI — cancels the pre-prompt timer. */
export interface PromptContext {
  promptOpened(): void;
}

export interface KeyboardInteractiveRequest {
  target: ConnectTarget;
  /** 1-based index of the USERAUTH_INFO_REQUEST within this session (PAM stacks send several). */
  round: number;
  name: string;
  instructions: string;
  prompts: KeyboardInteractivePrompt[];
}

export interface KeyboardInteractiveProvider {
  /** Resolve with one answer per prompt, or `null` when the user cancelled. */
  prompt(request: KeyboardInteractiveRequest, context: PromptContext): Promise<string[] | null>;
}

export interface HostKeyProvider {
  /**
   * ssh2 callback form ONLY: must return `undefined` and deliver the verdict
   * through `verdict(permitted)`. ssh2 treats any non-undefined return value —
   * a Promise from an `async` implementation included — as an immediate
   * verdict, which accepts the host before any prompt resolves.
   */
  verify(
    target: Pick<ConnectTarget, 'host' | 'port'>,
    key: Buffer,
    context: PromptContext,
    verdict: (permitted: boolean) => void
  ): void;
}

export interface ConnectProviders {
  keyboardInteractive?: KeyboardInteractiveProvider;
  hostKey?: HostKeyProvider;
  /** Route/prompt log line sink. Callers never pass secrets. */
  log: (line: string) => void;
}

export interface ConnectProviderInput {
  keyboardInteractive?: KeyboardInteractiveProvider;
  hostKey?: HostKeyProvider;
  log?: (line: string) => void;
}

/** Shares in-flight keyboard-interactive prompts between concurrent connects. */
export class KeyboardInteractiveCoordinator {
  readonly inFlight = new Map<string, Promise<string[] | null>>();
}

/** Set once at activation, read by every SSH connect; `clear()` is for tests and deactivation. */
export class ConnectProviderRegistry {
  private providers: ConnectProviderInput | undefined;
  readonly coordinator = new KeyboardInteractiveCoordinator();

  set(providers: ConnectProviderInput): void {
    if (this.providers) {
      throw new Error('Connect providers are already registered');
    }
    this.providers = providers;
  }

  get(): ConnectProviders {
    return {
      keyboardInteractive: this.providers?.keyboardInteractive,
      hostKey: this.providers?.hostKey,
      log: this.providers?.log ?? (() => undefined),
    };
  }

  clear(): void {
    this.providers = undefined;
    this.coordinator.inFlight.clear();
  }
}

export const connectProviderRegistry = new ConnectProviderRegistry();

export const PRE_PROMPT_TIMEOUT_MS = 20_000;

/**
 * Replaces ssh2's `readyTimeout` for interactive connects: ssh2's timer spans
 * the whole handshake *and* auth phase, so a TOFU modal or an OTP typed from a
 * phone would time the connection out. This timer only guards the stretch
 * before the first prompt opens.
 */
export class PrePromptTimer {
  private handle: ReturnType<typeof setTimeout> | undefined;

  constructor(timeoutMs: number, onExpire: () => void) {
    this.handle = setTimeout(() => {
      this.handle = undefined;
      onExpire();
    }, timeoutMs);
  }

  promptOpened(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}

export interface KeyboardInteractiveSessionOptions {
  target: ConnectTarget;
  authMethod: AuthMethod;
  /** Keychain password, used to auto-answer one `/password/i` prompt when `authMethod === 'password'`. */
  password?: string;
  /** Set false on a retry after a rejected keychain answer — every prompt then goes to the user. */
  allowKeychainAutoAnswer?: boolean;
  /** Called when a prompt was answered from the keychain without the user seeing it. */
  onKeychainAutoAnswer?: () => void;
  provider: KeyboardInteractiveProvider;
  context: PromptContext;
  log: (line: string) => void;
  /** Called instead of `finish` when the prompt was cancelled or failed — the connect must reject. */
  abort: (reason: string) => void;
}

/** Shape ssh2 hands to a `keyboard-interactive` listener (its `echo` is optional). */
export type Ssh2KeyboardInteractiveListener = (
  name: string,
  instructions: string,
  lang: string,
  prompts: Array<{ prompt: string; echo?: boolean }>,
  finish: (responses: string[]) => void
) => Promise<void>;

function describeTarget(target: ConnectTarget): string {
  return `${target.username}@${target.host}:${target.port}`;
}

/**
 * Builds the per-session `keyboard-interactive` listener.
 *
 * Coalescing is keyed on (target, round, prompt texts): sessions that hit the
 * same round of the same challenge while a prompt is open await that one
 * answer. A round-2 prompt never receives a round-1 answer (H1). When a
 * replayed answer is rejected (the server repeats the identical prompt — TOTP
 * servers refuse code reuse) the session is re-prompted once, directly; a
 * third identical prompt is answered empty so ssh2 fails the auth cleanly.
 */
export function createKeyboardInteractiveListener(
  coordinator: KeyboardInteractiveCoordinator,
  options: KeyboardInteractiveSessionOptions
): Ssh2KeyboardInteractiveListener {
  const route = describeTarget(options.target);
  let round = 0;
  let keychainAnswerUsed = false;
  let replayedPromptsKey: string | undefined;
  let rePromptedAfterReplay = false;

  return async (name, instructions, _lang, rawPrompts, finish) => {
    round += 1;
    const prompts: KeyboardInteractivePrompt[] = rawPrompts.map((p) => ({ prompt: p.prompt, echo: p.echo ?? false }));
    const promptsKey = prompts.map((p) => p.prompt).join('\n');
    const coalesceKey = `${route}|${round}|${promptsKey}`;
    options.log(`keyboard-interactive round ${round} for ${route}: ${prompts.length} prompt(s)`);

    const isPasswordOnly = prompts.length > 0 && prompts.every((p) => /password/i.test(p.prompt));
    if (
      options.authMethod === 'password' && options.password !== undefined
      && options.allowKeychainAutoAnswer !== false && !keychainAnswerUsed && isPasswordOnly
    ) {
      keychainAnswerUsed = true;
      options.log(`round ${round} for ${route}: answered from the keychain`);
      options.onKeychainAutoAnswer?.();
      finish(prompts.map(() => options.password as string));
      return;
    }

    const request: KeyboardInteractiveRequest = { target: options.target, round, name, instructions, prompts };
    let answers: string[] | null;
    try {
      if (replayedPromptsKey === promptsKey) {
        if (rePromptedAfterReplay) {
          options.log(`round ${round} for ${route}: replayed answer rejected twice — giving up`);
          finish(prompts.map(() => ''));
          return;
        }
        rePromptedAfterReplay = true;
        options.log(`round ${round} for ${route}: replayed answer rejected — asking again once`);
        answers = await options.provider.prompt(request, options.context);
      } else {
        const inFlight = coordinator.inFlight.get(coalesceKey);
        if (inFlight) {
          options.log(`round ${round} for ${route}: coalesced with the prompt already open`);
          answers = await inFlight;
          replayedPromptsKey = promptsKey;
        } else {
          const own = options.provider.prompt(request, options.context);
          coordinator.inFlight.set(coalesceKey, own);
          try {
            answers = await own;
          } finally {
            coordinator.inFlight.delete(coalesceKey);
          }
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      options.log(`round ${round} for ${route}: prompt failed — ${message}`);
      options.abort(`Keyboard-interactive prompt failed: ${message}`);
      return;
    }

    if (answers === null) {
      options.log(`round ${round} for ${route}: cancelled by the user`);
      options.abort('Connection cancelled: the authentication prompt was dismissed');
      return;
    }
    finish(answers);
  };
}
