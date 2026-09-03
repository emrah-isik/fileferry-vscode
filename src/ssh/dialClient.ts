import type { Client, ClientChannel } from 'ssh2';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { createCredentialDialer } from './chainConnect';
import { ConnectionCancelledError } from './connectErrors';
import { ConnectProviders, KeyboardInteractiveCoordinator } from './connectProviders';

/**
 * Raw ssh2 `Client` dial to one credential — feature 20 (Open SSH Terminal).
 *
 * The SFTP path owns its client through ssh2-sftp-client; the terminal does
 * not open an SFTP session at all — it needs a bare client to `exec` on. This
 * dials one with exactly the policies every other SSH connect has: the
 * registry's keyboard-interactive listener and host verifier (honouring
 * `interactive`), `DEFAULT_ALGORITHMS`, the pre-prompt timer, and the F8
 * rule — a silent keychain answer that gets rejected is retried ONCE without
 * the known-rejected password (see `createCredentialDialer`).
 *
 * `openSock` supplies the transport for chained targets (the last hop's
 * forward); it is called again for the retry so a dead channel is never
 * reused. This module must stay free of `vscode` imports.
 */

export interface DialClientOptions {
  interactive: boolean;
  /** Aborting rejects with `ConnectionCancelledError`, ends the client, and dismisses an open prompt. */
  signal?: AbortSignal;
  /** Opens the transport for one attempt (a forward through the last hop). Omit for a direct TCP dial. */
  openSock?: () => Promise<ClientChannel>;
}

export interface DialClientDependencies {
  providers: ConnectProviders;
  coordinator: KeyboardInteractiveCoordinator;
  createClient: () => Client;
}

function isAuthFailure(error: unknown): boolean {
  return /authentication methods failed/i.test((error as Error)?.message ?? '');
}

export async function dialClient(
  credential: SshCredentialWithSecret,
  options: DialClientOptions,
  dependencies: DialClientDependencies
): Promise<Client> {
  const dialer = createCredentialDialer(
    credential,
    options.openSock,
    { interactive: options.interactive, signal: options.signal },
    { providers: dependencies.providers, coordinator: dependencies.coordinator }
  );

  try {
    return await attemptDial(credential, dialer, options, dependencies);
  } catch (error: unknown) {
    // ssh2 offers keyboard-interactive exactly once per connection, so a
    // stale keychain auto-answer consumes the only attempt before the user
    // sees a prompt. Reconnect once with the auto-answer disabled — the
    // second `prepare` drops the known-rejected password (F8).
    const keychainAnswerRejected = dialer.keychainAnswerUsed && !dialer.userPrompted;
    if (!isAuthFailure(error) || !keychainAnswerRejected || options.signal?.aborted) {
      throw error;
    }
    return attemptDial(credential, dialer, options, dependencies);
  }
}

async function attemptDial(
  credential: SshCredentialWithSecret,
  dialer: ReturnType<typeof createCredentialDialer>,
  options: DialClientOptions,
  dependencies: DialClientDependencies
): Promise<Client> {
  const signal = options.signal;
  if (signal?.aborted) {
    throw new ConnectionCancelledError('the connection request was cancelled');
  }

  const client = dependencies.createClient();

  let rejectConnect: ((error: Error) => void) | undefined;
  let abortedWith: Error | undefined;
  const abortConnect = (reason: Error): void => {
    abortedWith = reason;
    rejectConnect?.(reason);
    client.end();
  };
  const onSignalAbort = (): void => {
    abortConnect(new ConnectionCancelledError('the connection request was cancelled'));
  };
  signal?.addEventListener('abort', onSignalAbort, { once: true });

  try {
    const config = await dialer.prepare(client, abortConnect);
    await new Promise<void>((resolve, reject) => {
      if (abortedWith) {
        reject(abortedWith);
        return;
      }
      rejectConnect = reject;
      const onReady = (): void => {
        client.removeListener('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        client.removeListener('ready', onReady);
        reject(error);
      };
      client.once('ready', onReady);
      client.once('error', onError);
      client.connect(config);
    });
  } catch (error: unknown) {
    client.end();
    if (abortedWith instanceof ConnectionCancelledError) {
      throw abortedWith;
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onSignalAbort);
  }

  dependencies.providers.log(
    `connected to ${credential.username}@${credential.host}:${credential.port}`
  );
  // Post-ready errors would crash the process without a listener; 'close'
  // follows and the consumer reacts to that.
  client.on('error', () => undefined);
  return client;
}
