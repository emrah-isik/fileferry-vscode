import * as fs from 'fs';
import * as os from 'os';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { resolveAgentSocket } from './agentResolver';
import {
  ConnectProviders,
  createKeyboardInteractiveListener,
  KeyboardInteractiveCoordinator,
  KeyboardInteractiveProvider,
  PrePromptTimer,
  PromptContext,
  PRE_PROMPT_TIMEOUT_MS,
} from './connectProviders';
import { HopConnectError, HostNotTrustedError, VerificationRequiredError } from './connectErrors';
import { DEFAULT_ALGORITHMS } from './defaultAlgorithms';
import { JumpHostDialer, JumpHostHandle, JumpHostPool } from './JumpHostPool';

/**
 * Jump-host chain connect (feature 18a-2a): resolves `[hop…, target]`, leases
 * every hop from the `JumpHostPool`, opens a `forwardOut` from each hop to the
 * next, and returns the final channel as the `sock` for the target's
 * `ssh2-sftp-client.connect()` (pass-through verified in the plan review §1).
 *
 * Raw ssh2 `Client`s for the hops belong to the chain layer (pool + the
 * dialers built here), never to ssh2-sftp-client; each hop dial registers its
 * own keyboard-interactive listener and host verifier honouring the
 * `interactive` flag (R8-18). Failures wrap in `HopConnectError` with the
 * failing hop attributed (Q17); the route is logged ONCE per connect to the
 * plain (unmasked) output channel — never interpolate secrets (L4).
 *
 * This module must stay free of `vscode` imports.
 */

export interface ChainConnectDependencies {
  pool: Pick<JumpHostPool, 'acquire'>;
  /** Looks a hop credential up by id, secrets included; `null` when it no longer exists. */
  resolveHopCredential(id: string): Promise<SshCredentialWithSecret | null>;
  providers: ConnectProviders;
  coordinator: KeyboardInteractiveCoordinator;
}

export interface ChainConnectTarget {
  host: string;
  port: number;
  username: string;
}

export interface ChainConnectResult {
  /** The last hop's forward to the target — hand it to ssh2-sftp-client as `sock`. */
  sock: ClientChannel;
  /** Releases every hop lease this connect acquired. Idempotent. */
  release(): void;
}

export async function chainConnect(
  target: ChainConnectTarget,
  hopIds: string[],
  options: { interactive: boolean },
  dependencies: ChainConnectDependencies
): Promise<ChainConnectResult> {
  if (hopIds.length === 0) {
    throw new Error('chainConnect called with no jump hosts — direct connects must not route through the chain');
  }

  const hopCredentials: SshCredentialWithSecret[] = [];
  for (const [hopIndex, hopId] of hopIds.entries()) {
    const credential = await dependencies.resolveHopCredential(hopId);
    if (!credential) {
      throw new HopConnectError(hopIndex, hopId, new Error(`jump host ${hopId} no longer exists`));
    }
    hopCredentials.push(credential);
  }

  const describeHop = (credential: SshCredentialWithSecret): string =>
    `${credential.username}@${credential.host}:${credential.port}`;
  dependencies.providers.log(
    `route: local → ${hopCredentials.map(describeHop).join(' → ')} → ${target.username}@${target.host}:${target.port}`
  );

  const handles: JumpHostHandle[] = [];
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    for (const handle of handles) {
      handle.release();
    }
  };

  try {
    let previousHandle: JumpHostHandle | undefined;
    for (const [hopIndex, hopCredential] of hopCredentials.entries()) {
      const carrier = previousHandle;
      try {
        const handle = await dependencies.pool.acquire({
          target: { username: hopCredential.username, host: hopCredential.host, port: hopCredential.port },
          sourceId: hopCredential.id,
          dialer: createHopDialer(hopCredential, carrier, options.interactive, dependencies),
        });
        handles.push(handle);
        previousHandle = handle;
      } catch (error: unknown) {
        throw toHopConnectError(hopIndex, hopCredential.host, error);
      }
    }

    const lastHopIndex = hopCredentials.length - 1;
    let sock: ClientChannel;
    try {
      sock = await previousHandle!.forwardOut('127.0.0.1', 0, target.host, target.port);
    } catch (error: unknown) {
      // The forward to the target is the last hop refusing/failing it —
      // attribute it there (AllowTcpForwarding/PermitOpen live on the hop).
      throw toHopConnectError(lastHopIndex, hopCredentials[lastHopIndex].host, error);
    }

    return { sock, release };
  } catch (error: unknown) {
    release();
    throw error;
  }
}

function toHopConnectError(hopIndex: number, hopHost: string, error: unknown): HopConnectError {
  if (error instanceof HopConnectError) {
    return error;
  }
  return new HopConnectError(hopIndex, hopHost, error instanceof Error ? error : new Error(String(error)));
}

/**
 * Builds the pool dialer for one hop. Each `prepare` call is one fresh dial
 * attempt (the pool re-invokes it for reconnects and its auth-failure retry),
 * so prompt/keychain state that must span attempts lives in this closure:
 * after a silent keychain auto-answer was rejected, the retry disables the
 * auto-answer AND drops the known-rejected password entirely — stock Ubuntu
 * sshd (UsePAM) kills the connection when a successful keyboard-interactive
 * follows a failed password auth on the same connection (18a-1a F8 finding).
 */
function createHopDialer(
  credential: SshCredentialWithSecret,
  carrier: JumpHostHandle | undefined,
  interactive: boolean,
  dependencies: ChainConnectDependencies
): JumpHostDialer {
  const attemptState = { keychainAnswerUsed: false, userPrompted: false };

  return {
    async prepare(client: Client, abortConnect: (reason: Error) => void): Promise<ConnectConfig> {
      const hopTarget = { username: credential.username, host: credential.host, port: credential.port };
      const providers = dependencies.providers;

      if (!interactive && credential.authMethod === 'keyboard-interactive') {
        // The hop's whole auth method is answering prompts — nothing a
        // background connect could attempt. Fail before dialing.
        throw new VerificationRequiredError(hopTarget.host, hopTarget.port);
      }

      const configuredProvider = interactive ? providers.keyboardInteractive : undefined;
      const keyboardInteractive: KeyboardInteractiveProvider | undefined = configuredProvider && {
        prompt: (request, context) => {
          attemptState.userPrompted = true;
          return configuredProvider.prompt(request, context);
        },
      };

      // The retry after a rejected silent keychain answer: ask the user, and
      // never re-offer the known-rejected password (see the function comment).
      const keychainAnswerRejected = attemptState.keychainAnswerUsed && !attemptState.userPrompted;
      const allowKeychainAutoAnswer = !keychainAnswerRejected;
      if (keychainAnswerRejected) {
        providers.log(
          `keychain answer for ${hopTarget.username}@${hopTarget.host}:${hopTarget.port} was rejected — asking interactively`
        );
      }

      let timer: PrePromptTimer | undefined;
      const context: PromptContext = { promptOpened: () => timer?.promptOpened() };

      if (keyboardInteractive) {
        client.on('keyboard-interactive', createKeyboardInteractiveListener(dependencies.coordinator, {
          target: hopTarget,
          authMethod: credential.authMethod,
          password: credential.password,
          provider: keyboardInteractive,
          allowKeychainAutoAnswer,
          onKeychainAutoAnswer: () => { attemptState.keychainAnswerUsed = true; },
          context,
          log: providers.log,
          abort: (reason) => abortConnect(new Error(reason)),
        }));
      }

      const hostVerifier = buildHopHostVerifier(hopTarget, interactive, context, providers, abortConnect);

      if (interactive) {
        // Q23/R4: interactive dials replace ssh2's readyTimeout with a 20 s
        // timer that only guards the stretch before the first prompt opens.
        timer = new PrePromptTimer(PRE_PROMPT_TIMEOUT_MS, () => {
          providers.log(
            `connect to ${hopTarget.username}@${hopTarget.host}:${hopTarget.port}: no prompt opened within 20 s — giving up`
          );
          abortConnect(new Error('Timed out waiting for the SSH handshake (20 s) before any prompt opened'));
        });
        const disposeTimer = (): void => timer?.dispose();
        client.once('ready', disposeTimer);
        client.once('error', disposeTimer);
        client.once('close', disposeTimer);
      }

      const config: ConnectConfig = {
        host: hopTarget.host,
        port: hopTarget.port,
        username: hopTarget.username,
        algorithms: DEFAULT_ALGORITHMS as ConnectConfig['algorithms'],
        tryKeyboard: keyboardInteractive !== undefined,
        ...(hostVerifier ? { hostVerifier } : {}),
        ...(interactive ? { readyTimeout: 0 } : {}),
      };

      if (credential.authMethod === 'password') {
        if (!keychainAnswerRejected) {
          config.password = credential.password;
        }
      } else if (credential.authMethod === 'key') {
        const keyPath = credential.privateKeyPath!.replace('~', os.homedir());
        try {
          config.privateKey = fs.readFileSync(keyPath);
        } catch {
          throw new Error(`Could not read private key file "${keyPath}". Check the file exists and is readable.`);
        }
        if (credential.passphrase) {
          config.passphrase = credential.passphrase;
        }
      } else if (credential.authMethod === 'agent') {
        config.agent = resolveAgentSocket(credential.agentSocketPath);
      }

      if (carrier) {
        // Hops beyond the first dial over a fresh forward from the previous
        // hop — opened per attempt, so a retry never reuses a dead stream.
        config.sock = await carrier.forwardOut('127.0.0.1', 0, hopTarget.host, hopTarget.port);
      }

      return config;
    },
  };
}

function buildHopHostVerifier(
  hopTarget: { host: string; port: number },
  interactive: boolean,
  context: PromptContext,
  providers: ConnectProviders,
  abortConnect: (reason: Error) => void
): ((key: Buffer, verify: (permitted: boolean) => void) => void) | undefined {
  const hostKeyProvider = providers.hostKey;
  if (!hostKeyProvider) {
    return undefined;
  }
  if (interactive) {
    return (key, verify) => {
      hostKeyProvider.verify({ host: hopTarget.host, port: hopTarget.port }, key, context, verify);
    };
  }
  // Store-only, fail closed — the typed error reaches the caller through
  // abortConnect so background chains surface HostNotTrustedError, not a
  // generic handshake failure.
  return (key, verify) => {
    hostKeyProvider.checkStored({ host: hopTarget.host, port: hopTarget.port }, key).then(
      (status) => {
        if (status === 'trusted') {
          verify(true);
          return;
        }
        abortConnect(new HostNotTrustedError(hopTarget.host, hopTarget.port, status));
        verify(false);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        providers.log(`host key store check for ${hopTarget.host}:${hopTarget.port} failed: ${message}`);
        abortConnect(new HostNotTrustedError(hopTarget.host, hopTarget.port, 'unknown'));
        verify(false);
      }
    );
  };
}
