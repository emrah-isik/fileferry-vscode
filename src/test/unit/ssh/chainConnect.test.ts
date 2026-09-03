import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { chainConnect, ChainConnectDependencies } from '../../../ssh/chainConnect';
import { JumpHostPool } from '../../../ssh/JumpHostPool';
import {
  ConnectProviders,
  KeyboardInteractiveCoordinator,
  KeyboardInteractiveProvider,
  HostKeyProvider,
  StoredHostKeyStatus,
} from '../../../ssh/connectProviders';
import { HopConnectError, HostNotTrustedError, VerificationRequiredError } from '../../../ssh/connectErrors';
import { SshCredentialWithSecret } from '../../../models/SshCredential';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const HOST_KEY = Buffer.from('fake-public-key');

class FakeSshClient extends EventEmitter {
  connectConfig: ConnectConfig | undefined;
  ended = false;
  forwardOutCalls: Array<{ destinationHost: string; destinationPort: number }> = [];
  static nextAuthFailures = 0;

  connect(config: ConnectConfig): this {
    this.connectConfig = config;
    setImmediate(() => {
      if (FakeSshClient.nextAuthFailures > 0) {
        FakeSshClient.nextAuthFailures -= 1;
        this.emit('error', new Error('All configured authentication methods failed'));
        return;
      }
      // Drive the verifier the way ssh2 does — during the handshake, before
      // 'ready' (see driveSsh2HostVerifier). No verifier = accept.
      const verifier = config.hostVerifier as
        | ((key: Buffer, verify: (permitted: boolean) => void) => unknown)
        | undefined;
      const settle = (permitted: unknown): void => {
        if (permitted !== false) {
          this.emit('ready');
        } else {
          this.emit('error', new Error('Host verification failed'));
        }
      };
      if (!verifier) {
        settle(true);
        return;
      }
      const returned = verifier(HOST_KEY, settle);
      if (returned !== undefined) {
        settle(returned);
      }
    });
    return this;
  }

  end(): this {
    this.ended = true;
    setImmediate(() => this.emit('close'));
    return this;
  }

  forwardOut(
    _sourceHost: string,
    _sourcePort: number,
    destinationHost: string,
    destinationPort: number,
    callback: (error: Error | undefined, channel: ClientChannel) => void
  ): void {
    this.forwardOutCalls.push({ destinationHost, destinationPort });
    callback(undefined, { fakeChannelFrom: this, to: `${destinationHost}:${destinationPort}` } as unknown as ClientChannel);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const bastionCredential: SshCredentialWithSecret = {
  id: 'cred-bastion', name: 'Bastion', host: 'bastion.example.com', port: 2222,
  username: 'jump', authMethod: 'password', password: 'bastion-secret',
};

const innerHopCredential: SshCredentialWithSecret = {
  id: 'cred-inner', name: 'Inner Hop', host: 'inner.example.com', port: 22,
  username: 'relay', authMethod: 'password', password: 'inner-secret',
};

const target = { host: 'target.internal', port: 22, username: 'deploy' };

describe('chainConnect', () => {
  let clients: FakeSshClient[];
  let logLines: string[];
  let pool: JumpHostPool;
  let keyboardInteractivePrompts: number;
  let storedStatus: StoredHostKeyStatus;
  let verifyCalls: Array<{ host: string; port: number }>;
  let credentials: Map<string, SshCredentialWithSecret>;

  const keyboardInteractiveProvider: KeyboardInteractiveProvider = {
    prompt: async () => {
      keyboardInteractivePrompts += 1;
      return ['typed-answer'];
    },
  };

  const hostKeyProvider: HostKeyProvider = {
    verify: (hopTarget, _key, _context, verdict) => {
      verifyCalls.push({ host: hopTarget.host, port: hopTarget.port });
      verdict(true);
    },
    checkStored: async () => storedStatus,
  };

  function dependencies(overrides?: Partial<ConnectProviders>): ChainConnectDependencies {
    return {
      pool,
      coordinator: new KeyboardInteractiveCoordinator(),
      resolveHopCredential: async (id) => credentials.get(id) ?? null,
      providers: {
        keyboardInteractive: keyboardInteractiveProvider,
        hostKey: hostKeyProvider,
        log: (line) => logLines.push(line),
        warn: (message) => logLines.push(message),
        ...overrides,
      },
    };
  }

  beforeEach(() => {
    clients = [];
    logLines = [];
    keyboardInteractivePrompts = 0;
    storedStatus = 'trusted';
    verifyCalls = [];
    FakeSshClient.nextAuthFailures = 0;
    credentials = new Map([
      [bastionCredential.id, bastionCredential],
      [innerHopCredential.id, innerHopCredential],
    ]);
    pool = new JumpHostPool({
      createClient: () => {
        const client = new FakeSshClient();
        clients.push(client);
        return client as unknown as Client;
      },
      log: (line) => logLines.push(line),
    });
  });

  afterEach(() => {
    pool.dispose();
  });

  // 18a-2b (§I wedge fix): a superseded connect aborts via options.signal —
  // the chain must stop waiting, never leak a lease, and hand providers the
  // signal so an open prompt can be dismissed.
  describe('abort signal', () => {
    const flushMicrotasks = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('an abort while a hop dial is parked rejects with the cancel error, and the late lease is released', async () => {
      let resolveAcquire!: (handle: unknown) => void;
      const release = jest.fn();
      const stubPool = { acquire: jest.fn(() => new Promise(resolve => { resolveAcquire = resolve; })) };
      const controller = new AbortController();

      const pending = chainConnect(
        target,
        [bastionCredential.id],
        { interactive: true, signal: controller.signal },
        { ...dependencies(), pool: stubPool as unknown as JumpHostPool }
      );
      await flushMicrotasks();
      controller.abort();

      await expect(pending).rejects.toThrow(/cancelled/i);
      await expect(pending).rejects.not.toBeInstanceOf(HopConnectError);

      // The raced-out acquire settles later — its lease must not leak.
      resolveAcquire({ key: 'k', forwardOut: jest.fn(), release });
      await flushMicrotasks();
      expect(release).toHaveBeenCalled();
    });

    it('an already-aborted signal rejects before acquiring anything', async () => {
      const stubPool = { acquire: jest.fn() };
      const controller = new AbortController();
      controller.abort();

      await expect(chainConnect(
        target,
        [bastionCredential.id],
        { interactive: true, signal: controller.signal },
        { ...dependencies(), pool: stubPool as unknown as JumpHostPool }
      )).rejects.toThrow(/cancelled/i);
      expect(stubPool.acquire).not.toHaveBeenCalled();
    });

    it('hop prompt contexts carry the signal so providers can dismiss open prompts', async () => {
      const controller = new AbortController();
      let seenContext: { signal?: AbortSignal } | undefined;
      const dependenciesWithCapture = dependencies({
        hostKey: {
          verify: (_hopTarget, _key, context, verdict) => {
            seenContext = context;
            verdict(true);
          },
          checkStored: async () => storedStatus,
        },
      });

      const result = await chainConnect(
        target,
        [bastionCredential.id],
        { interactive: true, signal: controller.signal },
        dependenciesWithCapture
      );
      expect(seenContext?.signal).toBe(controller.signal);
      result.release();
    });
  });

  it('connects one hop and returns the forward to the target as sock', async () => {
    const result = await chainConnect(target, [bastionCredential.id], { interactive: true }, dependencies());
    expect(clients).toHaveLength(1);
    expect(clients[0].connectConfig).toEqual(expect.objectContaining({
      host: 'bastion.example.com',
      port: 2222,
      username: 'jump',
      password: 'bastion-secret',
    }));
    expect(clients[0].forwardOutCalls).toEqual([{ destinationHost: 'target.internal', destinationPort: 22 }]);
    expect((result.sock as unknown as { to: string }).to).toBe('target.internal:22');
    result.release();
  });

  it('chains two hops: the second hop dials over the first hop\'s forward (sock)', async () => {
    const result = await chainConnect(
      target,
      [bastionCredential.id, innerHopCredential.id],
      { interactive: true },
      dependencies()
    );
    expect(clients).toHaveLength(2);
    // Hop 1 forwards to hop 2's endpoint, then to the target from hop 2.
    expect(clients[0].forwardOutCalls).toEqual([{ destinationHost: 'inner.example.com', destinationPort: 22 }]);
    const sockOfSecondHop = clients[1].connectConfig?.sock as unknown as { fakeChannelFrom: FakeSshClient; to: string };
    expect(sockOfSecondHop.fakeChannelFrom).toBe(clients[0]);
    expect(sockOfSecondHop.to).toBe('inner.example.com:22');
    expect(clients[1].forwardOutCalls).toEqual([{ destinationHost: 'target.internal', destinationPort: 22 }]);
    result.release();
  });

  it('logs the route once, without secrets (Q17/L4)', async () => {
    const result = await chainConnect(
      target,
      [bastionCredential.id, innerHopCredential.id],
      { interactive: true },
      dependencies()
    );
    const routeLines = logLines.filter(line => line.startsWith('route:'));
    expect(routeLines).toEqual([
      'route: local → jump@bastion.example.com:2222 → relay@inner.example.com:22 → deploy@target.internal:22',
    ]);
    expect(logLines.join('\n')).not.toContain('bastion-secret');
    expect(logLines.join('\n')).not.toContain('inner-secret');
    result.release();
  });

  it('a dangling hop id fails with HopConnectError before any dial (Q28)', async () => {
    const attempt = chainConnect(target, ['cred-gone'], { interactive: true }, dependencies());
    await expect(attempt).rejects.toThrow(HopConnectError);
    await expect(attempt).rejects.toThrow(/cred-gone.*no longer exists/);
    expect(clients).toHaveLength(0);
  });

  it('a hop auth failure wraps in HopConnectError with hopIndex and hopHost (Q17)', async () => {
    FakeSshClient.nextAuthFailures = 2; // initial + the pool's one retry
    const attempt = chainConnect(target, [bastionCredential.id], { interactive: true }, dependencies());
    await expect(attempt).rejects.toMatchObject({
      name: 'HopConnectError',
      hopIndex: 0,
      hopHost: 'bastion.example.com',
    });
  });

  it('a second-hop failure releases the already-acquired first hop', async () => {
    FakeSshClient.nextAuthFailures = 0;
    credentials.set(innerHopCredential.id, { ...innerHopCredential, password: undefined });
    // Make only the second hop fail (first dial succeeds, then two failures for hop 2).
    const originalConnect = FakeSshClient.prototype.connect;
    let dialCount = 0;
    jest.spyOn(FakeSshClient.prototype, 'connect').mockImplementation(function (this: FakeSshClient, config: ConnectConfig) {
      dialCount += 1;
      if (dialCount > 1) {
        this.connectConfig = config;
        setImmediate(() => this.emit('error', new Error('All configured authentication methods failed')));
        return this;
      }
      return originalConnect.call(this, config);
    });
    try {
      await expect(
        chainConnect(target, [bastionCredential.id, innerHopCredential.id], { interactive: true }, dependencies())
      ).rejects.toMatchObject({ hopIndex: 1, hopHost: 'inner.example.com' });
      // The bastion lease was released: drain() must close it immediately (idle).
      pool.drain();
      await new Promise((resolve) => setImmediate(resolve));
      expect(clients[0].ended).toBe(true);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('interactive hops verify host keys through the provider during the handshake (R8-18)', async () => {
    const result = await chainConnect(target, [bastionCredential.id], { interactive: true }, dependencies());
    expect(verifyCalls).toEqual([{ host: 'bastion.example.com', port: 2222 }]);
    result.release();
  });

  it('non-interactive hops use the store-only check and fail closed with HostNotTrustedError', async () => {
    storedStatus = 'unknown';
    const error = await chainConnect(target, [bastionCredential.id], { interactive: false }, dependencies())
      .catch((e: unknown) => e) as HopConnectError;
    expect(error).toBeInstanceOf(HopConnectError);
    expect(error.cause).toBeInstanceOf(HostNotTrustedError);
    expect((error.cause as HostNotTrustedError).status).toBe('unknown');
    expect(verifyCalls).toHaveLength(0); // never the prompting path
  });

  it('non-interactive hops with a trusted stored key connect without any prompt provider involvement', async () => {
    storedStatus = 'trusted';
    const result = await chainConnect(target, [bastionCredential.id], { interactive: false }, dependencies());
    expect(verifyCalls).toHaveLength(0);
    expect(keyboardInteractivePrompts).toBe(0);
    result.release();
  });

  it('a keyboard-interactive hop on a non-interactive connect fails fast before dialing', async () => {
    credentials.set(bastionCredential.id, { ...bastionCredential, authMethod: 'keyboard-interactive' });
    const error = await chainConnect(target, [bastionCredential.id], { interactive: false }, dependencies())
      .catch((e: unknown) => e) as HopConnectError;
    expect(error).toBeInstanceOf(HopConnectError);
    expect(error.cause).toBeInstanceOf(VerificationRequiredError);
  });

  it('registers a keyboard-interactive listener per interactive hop (R8-18)', async () => {
    const result = await chainConnect(target, [bastionCredential.id], { interactive: true }, dependencies());
    expect(clients[0].listenerCount('keyboard-interactive')).toBe(1);
    expect(clients[0].connectConfig?.tryKeyboard).toBe(true);
    result.release();
  });

  it('non-interactive hops never register the listener and keep tryKeyboard off', async () => {
    const result = await chainConnect(target, [bastionCredential.id], { interactive: false }, dependencies());
    expect(clients[0].listenerCount('keyboard-interactive')).toBe(0);
    expect(clients[0].connectConfig?.tryKeyboard).toBe(false);
    result.release();
  });

  it('after a keychain auto-answer is rejected, the retry drops the password and asks the user (R5/F8)', async () => {
    // First dial: the KI challenge is auto-answered from the keychain, then
    // auth fails. The pool retries once; the retry must offer NO password
    // (known-rejected — stock Ubuntu sshd kills pw-fail→KI-success) and must
    // route the prompt to the user.
    const originalConnect = FakeSshClient.prototype.connect;
    let dialCount = 0;
    jest.spyOn(FakeSshClient.prototype, 'connect').mockImplementation(function (this: FakeSshClient, config: ConnectConfig) {
      dialCount += 1;
      this.connectConfig = config;
      const isFirstDial = dialCount === 1;
      setImmediate(() => {
        this.emit(
          'keyboard-interactive', 'name', '', 'en', [{ prompt: 'Password:', echo: false }],
          (_responses: string[]) => {
            if (isFirstDial) {
              setImmediate(() => this.emit('error', new Error('All configured authentication methods failed')));
            } else {
              setImmediate(() => this.emit('ready'));
            }
          }
        );
      });
      return this;
    });
    try {
      const result = await chainConnect(target, [bastionCredential.id], { interactive: true }, dependencies());
      expect(dialCount).toBe(2);
      expect(clients[0].connectConfig?.password).toBe('bastion-secret');
      expect(clients[1].connectConfig?.password).toBeUndefined();
      expect(keyboardInteractivePrompts).toBe(1); // only the retry asked the user
      result.release();
    } finally {
      jest.restoreAllMocks();
      void originalConnect;
    }
  });

  it('reads the private key file for key-auth hops — a mid-path ~ is NOT expanded', async () => {
    // The directory name contains a literal ~ (as Windows 8.3 short paths
    // like C:\Users\RUNNER~1 do): only a LEADING ~ may expand to homedir.
    const keyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fileferry~18a2a-'));
    const keyPath = path.join(keyDirectory, `test-key-${process.pid}`);
    fs.writeFileSync(keyPath, 'FAKE KEY MATERIAL');
    try {
      credentials.set(bastionCredential.id, {
        ...bastionCredential, authMethod: 'key', password: undefined,
        privateKeyPath: keyPath, passphrase: 'key-passphrase',
      });
      const result = await chainConnect(target, [bastionCredential.id], { interactive: true }, dependencies());
      expect(clients[0].connectConfig?.privateKey?.toString()).toBe('FAKE KEY MATERIAL');
      expect(clients[0].connectConfig?.passphrase).toBe('key-passphrase');
      result.release();
    } finally {
      fs.rmSync(keyDirectory, { recursive: true, force: true });
    }
  });

  it('release releases every hop: drain then closes both immediately', async () => {
    const result = await chainConnect(
      target,
      [bastionCredential.id, innerHopCredential.id],
      { interactive: true },
      dependencies()
    );
    result.release();
    pool.drain();
    await new Promise((resolve) => setImmediate(resolve));
    expect(clients[0].ended).toBe(true);
    expect(clients[1].ended).toBe(true);
  });

  it('rejects an empty hop list — callers must not route direct connects through the chain', async () => {
    await expect(chainConnect(target, [], { interactive: true }, dependencies())).rejects.toThrow(/no jump hosts/i);
  });
});

// ─── 18b: hops derived from ~/.ssh/config ProxyJump ──────────────────────────

describe('chainConnect with config-derived hops (18b)', () => {
  let clients: FakeSshClient[];
  let logLines: string[];
  let pool: JumpHostPool;
  let savedAgentSocket: string | undefined;

  const configHop = { alias: 'bastion', host: 'bastion.example.com', port: 2222, user: 'jump' };

  function dependencies(overrides?: Partial<ConnectProviders>, sshConfigText?: string): ChainConnectDependencies {
    return {
      pool,
      coordinator: new KeyboardInteractiveCoordinator(),
      resolveHopCredential: async (id) => (id === bastionCredential.id ? bastionCredential : null),
      providers: {
        keyboardInteractive: { prompt: async () => ['typed'] },
        log: (line) => logLines.push(line),
        warn: (message) => logLines.push(message),
        ...overrides,
      },
      sshConfig: { homeDir: '/home/dev', localUser: 'localdev', readFile: () => sshConfigText ?? null },
    };
  }

  beforeEach(() => {
    clients = [];
    logLines = [];
    FakeSshClient.nextAuthFailures = 0;
    savedAgentSocket = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    pool = new JumpHostPool({
      createClient: () => {
        const client = new FakeSshClient();
        clients.push(client);
        return client as unknown as Client;
      },
      log: (line) => logLines.push(line),
    });
  });

  afterEach(() => {
    pool.dispose();
    if (savedAgentSocket === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = savedAgentSocket;
    }
  });

  it('dials a config hop with its IdentityFile as key auth, keyed and sourced by its alias', async () => {
    const keyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fileferry-18b-'));
    const keyPath = path.join(keyDirectory, 'bastion_ed25519');
    fs.writeFileSync(keyPath, 'CONFIG HOP KEY');
    try {
      const result = await chainConnect(target, [{ ...configHop, identityFile: keyPath }], { interactive: true }, dependencies());
      expect(clients[0].connectConfig).toMatchObject({ host: 'bastion.example.com', port: 2222, username: 'jump' });
      expect(clients[0].connectConfig?.privateKey?.toString()).toBe('CONFIG HOP KEY');
      expect(clients[0].connectConfig?.password).toBeUndefined();
      expect(result.hopKeys).toEqual(['jump@bastion.example.com:2222']);
      expect(logLines).toContain('route: local → jump@bastion.example.com:2222 → deploy@target.internal:22');
      result.release();
    } finally {
      fs.rmSync(keyDirectory, { recursive: true, force: true });
    }
  });

  it('falls back to the SSH agent when the hop has no IdentityFile (Q15)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent.sock';
    const result = await chainConnect(target, [configHop], { interactive: true }, dependencies());
    expect(clients[0].connectConfig?.agent).toBe('/tmp/fake-agent.sock');
    expect(clients[0].connectConfig?.privateKey).toBeUndefined();
    result.release();
  });

  it('falls back to interactive prompts when there is no IdentityFile and no agent (Q15)', async () => {
    const result = await chainConnect(target, [configHop], { interactive: true }, dependencies());
    expect(clients[0].connectConfig?.tryKeyboard).toBe(true);
    expect(clients[0].connectConfig?.agent).toBeUndefined();
    expect(clients[0].connectConfig?.privateKey).toBeUndefined();
    expect(clients[0].connectConfig?.password).toBeUndefined();
    expect(clients[0].listenerCount('keyboard-interactive')).toBe(1);
    result.release();
  });

  it('fails with the Q15 message when nothing can authenticate the hop and no prompt provider exists', async () => {
    const error = await chainConnect(target, [configHop], { interactive: true }, dependencies({ keyboardInteractive: undefined }))
      .then(() => { throw new Error('expected the chain to fail'); }, (caught: unknown) => caught as HopConnectError);
    expect(error).toBeInstanceOf(HopConnectError);
    expect(error.hopIndex).toBe(0);
    expect(error.hopHost).toBe('bastion.example.com');
    expect(error.cause.message).toBe(
      'hop 1 (bastion): no IdentityFile, no agent — add IdentityFile or define it as a FileFerry credential'
    );
    expect(clients).toHaveLength(0);
  });

  it('a prompt-only config hop on a non-interactive connect fails fast with VerificationRequiredError', async () => {
    const error = await chainConnect(target, [configHop], { interactive: false }, dependencies())
      .then(() => { throw new Error('expected the chain to fail'); }, (caught: unknown) => caught as HopConnectError);
    expect(error).toBeInstanceOf(HopConnectError);
    expect(error.cause).toBeInstanceOf(VerificationRequiredError);
  });

  it('explains an auth failure on a config hop in terms of what ProxyJump hosts can use', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent.sock';
    FakeSshClient.nextAuthFailures = 2; // the pool retries an auth failure once
    const error = await chainConnect(target, [configHop], { interactive: true }, dependencies())
      .then(() => { throw new Error('expected the chain to fail'); }, (caught: unknown) => caught as HopConnectError);
    expect(error).toBeInstanceOf(HopConnectError);
    expect(error.cause.message).toMatch(/authentication methods failed/i);
    expect(error.cause.message).toMatch(/define "bastion" as a FileFerry credential/);
  });

  it('resolves a hop CREDENTIAL that opts into ~/.ssh/config independently (R8-5)', async () => {
    const aliasHop: SshCredentialWithSecret = { ...bastionCredential, host: 'bastion-alias', port: 22, username: '', useSshConfig: true };
    const sshConfigText = 'Host bastion-alias\n  HostName bastion.example.com\n  Port 2222\n  User jump\n  ProxyJump ignored-nested\n';
    const deps = { ...dependencies(undefined, sshConfigText), resolveHopCredential: async () => aliasHop };
    const result = await chainConnect(target, [bastionCredential.id], { interactive: true }, deps);
    expect(clients[0].connectConfig).toMatchObject({ host: 'bastion.example.com', port: 2222, username: 'jump' });
    expect(result.hopKeys).toEqual(['jump@bastion.example.com:2222']);
    expect(logLines).toContain(
      'ProxyJump for jump host "bastion-alias" ignored — jump-host credentials are flat (add the extra hop to the target\'s chain instead)'
    );
    result.release();
  });

  it('mixes credential hops and config hops in route order', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent.sock';
    const result = await chainConnect(target, [bastionCredential.id, { ...configHop, alias: 'inner', host: 'inner.example.com', port: 22, user: 'relay' }], { interactive: true }, dependencies());
    expect(result.hopKeys).toEqual(['jump@bastion.example.com:2222', 'relay@inner.example.com:22']);
    expect(clients[1].connectConfig?.sock).toBeDefined();
    result.release();
  });
});
