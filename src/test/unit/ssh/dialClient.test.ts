import { EventEmitter } from 'events';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { dialClient, DialClientDependencies } from '../../../ssh/dialClient';
import {
  KeyboardInteractiveCoordinator,
  KeyboardInteractiveProvider,
  HostKeyProvider,
} from '../../../ssh/connectProviders';
import { ConnectionCancelledError } from '../../../ssh/connectErrors';
import { DEFAULT_ALGORITHMS } from '../../../ssh/defaultAlgorithms';
import { SshCredentialWithSecret } from '../../../models/SshCredential';

// ─── Fake ssh2 client ────────────────────────────────────────────────────────
// Drives the host verifier the way ssh2 does, then either becomes ready,
// fails auth, or raises one keyboard-interactive "Password:" round whose
// answer decides the outcome — enough to exercise the F8 keychain retry.

const HOST_KEY = Buffer.from('fake-public-key');

type AuthBehaviour = 'ready' | 'auth-failure' | 'keyboard-interactive';

class FakeSshClient extends EventEmitter {
  connectConfig: ConnectConfig | undefined;
  ended = false;
  static behaviour: AuthBehaviour = 'ready';
  static acceptedAnswer = 'good';

  connect(config: ConnectConfig): this {
    this.connectConfig = config;
    setImmediate(() => {
      const verifier = config.hostVerifier as
        | ((key: Buffer, verify: (permitted: boolean) => void) => unknown)
        | undefined;
      const afterVerify = (permitted: unknown): void => {
        if (permitted === false) {
          this.emit('error', new Error('Host verification failed'));
          return;
        }
        this.authenticate(config);
      };
      if (!verifier) {
        afterVerify(true);
        return;
      }
      const returned = verifier(HOST_KEY, afterVerify);
      if (returned !== undefined) {
        afterVerify(returned);
      }
    });
    return this;
  }

  private authenticate(config: ConnectConfig): void {
    switch (FakeSshClient.behaviour) {
      case 'ready':
        this.emit('ready');
        return;
      case 'auth-failure':
        this.emit('error', new Error('All configured authentication methods failed'));
        return;
      case 'keyboard-interactive':
        if (!config.tryKeyboard) {
          this.emit('error', new Error('All configured authentication methods failed'));
          return;
        }
        this.emit('keyboard-interactive', 'login', '', '', [{ prompt: 'Password:', echo: false }], (answers: string[]) => {
          if (answers[0] === FakeSshClient.acceptedAnswer) {
            this.emit('ready');
          } else {
            this.emit('error', new Error('All configured authentication methods failed'));
          }
        });
        return;
    }
  }

  end(): this {
    this.ended = true;
    setImmediate(() => this.emit('close'));
    return this;
  }
}

const credential: SshCredentialWithSecret = {
  id: 'cred-target', name: 'Target', host: 'target.example.com', port: 22,
  username: 'deploy', authMethod: 'password', password: 'keychain-secret',
};

describe('dialClient', () => {
  let clients: FakeSshClient[];
  let logLines: string[];
  let promptedAnswers: string[][];
  let promptAnswer: string[] | null;

  const keyboardInteractiveProvider: KeyboardInteractiveProvider = {
    prompt: async () => {
      promptedAnswers.push(promptAnswer ?? []);
      return promptAnswer;
    },
  };

  const hostKeyProvider: HostKeyProvider = {
    verify: (_target, _key, _context, verdict) => verdict(true),
    checkStored: async () => 'trusted',
  };

  function dependencies(): DialClientDependencies {
    return {
      createClient: () => {
        const client = new FakeSshClient();
        clients.push(client);
        return client as unknown as Client;
      },
      coordinator: new KeyboardInteractiveCoordinator(),
      providers: {
        keyboardInteractive: keyboardInteractiveProvider,
        hostKey: hostKeyProvider,
        log: (line) => logLines.push(line),
        warn: (message) => logLines.push(message),
      },
    };
  }

  beforeEach(() => {
    clients = [];
    logLines = [];
    promptedAnswers = [];
    promptAnswer = ['good'];
    FakeSshClient.behaviour = 'ready';
    FakeSshClient.acceptedAnswer = 'good';
  });

  it('dials the credential directly with the shared defaults and resolves the ready client', async () => {
    const client = await dialClient(credential, { interactive: true }, dependencies());

    expect(client).toBe(clients[0]);
    expect(clients).toHaveLength(1);
    expect(clients[0].connectConfig).toEqual(expect.objectContaining({
      host: 'target.example.com',
      port: 22,
      username: 'deploy',
      password: 'keychain-secret',
      algorithms: DEFAULT_ALGORITHMS,
      tryKeyboard: true,
      readyTimeout: 0,
    }));
    expect(clients[0].connectConfig?.sock).toBeUndefined();
    expect(clients[0].ended).toBe(false);
  });

  it('dials over the sock openSock provides (a forward through the last hop)', async () => {
    const sock = { fake: 'forwarded-channel' } as unknown as ClientChannel;
    const openSock = jest.fn(async () => sock);

    await dialClient(credential, { interactive: true, openSock }, dependencies());

    expect(openSock).toHaveBeenCalledTimes(1);
    expect(clients[0].connectConfig?.sock).toBe(sock);
  });

  it('rejects with the connection error and ends the client', async () => {
    FakeSshClient.behaviour = 'auth-failure';

    await expect(dialClient(credential, { interactive: true }, dependencies()))
      .rejects.toThrow('All configured authentication methods failed');

    expect(clients).toHaveLength(1);
    expect(clients[0].ended).toBe(true);
  });

  it('retries ONCE without the known-rejected password after a silent keychain answer fails (F8)', async () => {
    FakeSshClient.behaviour = 'keyboard-interactive';
    let attempts = 0;
    const openSock = jest.fn(async (): Promise<ClientChannel> => ({ attempt: ++attempts } as unknown as ClientChannel));

    const client = await dialClient(credential, { interactive: true, openSock }, dependencies());

    // First attempt: the keychain answered the "Password:" round silently and
    // was rejected. Second attempt: no password offered, the user is asked.
    expect(clients).toHaveLength(2);
    expect(client).toBe(clients[1]);
    expect(clients[0].connectConfig?.password).toBe('keychain-secret');
    expect(clients[0].ended).toBe(true);
    expect(clients[1].connectConfig).not.toHaveProperty('password');
    expect(promptedAnswers).toEqual([['good']]);
    // A fresh transport per attempt — the first one died with its client.
    expect(openSock).toHaveBeenCalledTimes(2);
    expect(logLines.some((line) => /keychain answer .* was rejected/.test(line))).toBe(true);
  });

  it('does not retry when the user already typed the rejected answer', async () => {
    FakeSshClient.behaviour = 'keyboard-interactive';
    FakeSshClient.acceptedAnswer = 'something-else';
    const keyCredential: SshCredentialWithSecret = { ...credential, authMethod: 'keyboard-interactive', password: undefined };

    await expect(dialClient(keyCredential, { interactive: true }, dependencies()))
      .rejects.toThrow('All configured authentication methods failed');

    expect(clients).toHaveLength(1);
    expect(promptedAnswers).toHaveLength(1);
  });

  it('rejects with "Connection cancelled" when the prompt is dismissed', async () => {
    FakeSshClient.behaviour = 'keyboard-interactive';
    promptAnswer = null;
    const keyCredential: SshCredentialWithSecret = { ...credential, authMethod: 'keyboard-interactive', password: undefined };

    await expect(dialClient(keyCredential, { interactive: true }, dependencies()))
      .rejects.toThrow(/Connection cancelled/);

    expect(clients[0].ended).toBe(true);
  });

  it('rejects with ConnectionCancelledError and ends the client when the signal aborts mid-dial', async () => {
    const controller = new AbortController();
    let releaseVerifier: (() => void) | undefined;
    const slowHostKeyProvider: HostKeyProvider = {
      verify: (_target, _key, _context, verdict) => { releaseVerifier = () => verdict(true); },
      checkStored: async () => 'trusted',
    };
    const deps = dependencies();
    deps.providers.hostKey = slowHostKeyProvider;

    const pending = dialClient(credential, { interactive: true, signal: controller.signal }, deps);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ConnectionCancelledError);
    expect(clients[0].ended).toBe(true);
    // The late verdict lands on an already-rejected dial — harmless.
    releaseVerifier?.();
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(dialClient(credential, { interactive: true, signal: controller.signal }, dependencies()))
      .rejects.toBeInstanceOf(ConnectionCancelledError);
    expect(clients).toHaveLength(0);
  });

  it('swallows post-ready client errors instead of crashing the process', async () => {
    const client = await dialClient(credential, { interactive: true }, dependencies());

    expect(() => (client as unknown as EventEmitter).emit('error', new Error('late failure'))).not.toThrow();
  });
});
