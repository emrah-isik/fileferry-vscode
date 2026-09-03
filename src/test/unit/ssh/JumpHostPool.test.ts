import { EventEmitter } from 'events';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { JumpHostPool, JUMP_HOST_IDLE_TIMEOUT_MS, JumpHostDialer } from '../../../ssh/JumpHostPool';

// ─── createClient fake ───────────────────────────────────────────────────────
// Emits 'ready' (or 'error') when the test decides, records connect configs
// and forwardOut calls — the pool never touches a real socket in these tests.

class FakeSshClient extends EventEmitter {
  connectConfig: ConnectConfig | undefined;
  ended = false;
  forwardOutCalls: Array<{ sourceHost: string; sourcePort: number; destinationHost: string; destinationPort: number }> = [];
  forwardOutBehaviour: 'succeed' | 'fail' = 'succeed';

  connect(config: ConnectConfig): this {
    this.connectConfig = config;
    return this;
  }

  end(): this {
    this.ended = true;
    // Real ssh2 emits 'close' asynchronously after end().
    setImmediate(() => this.emit('close'));
    return this;
  }

  forwardOut(
    sourceHost: string,
    sourcePort: number,
    destinationHost: string,
    destinationPort: number,
    callback: (error: Error | undefined, channel: ClientChannel) => void
  ): void {
    this.forwardOutCalls.push({ sourceHost, sourcePort, destinationHost, destinationPort });
    if (this.forwardOutBehaviour === 'fail') {
      callback(new Error('Channel open failure'), undefined as unknown as ClientChannel);
      return;
    }
    callback(undefined, { fake: 'channel', from: this } as unknown as ClientChannel);
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('JumpHostPool', () => {
  let clients: FakeSshClient[];
  let logLines: string[];
  let pool: JumpHostPool;
  let readyMode: 'auto' | 'manual';
  let authFailuresRemaining: number;
  let forwardBehaviourForNewClients: 'succeed' | 'fail';

  const target = { username: 'jump', host: 'bastion.example.com', port: 22 };

  function makeDialer(): JumpHostDialer & { prepareCalls: number } {
    const dialer = {
      prepareCalls: 0,
      async prepare(): Promise<ConnectConfig> {
        dialer.prepareCalls += 1;
        return { host: target.host, port: target.port, username: target.username, password: 'secret' };
      },
    };
    return dialer;
  }

  function request(sourceId = 'cred-bastion') {
    return { target, sourceId, dialer: makeDialer() };
  }

  beforeEach(() => {
    clients = [];
    logLines = [];
    readyMode = 'auto';
    authFailuresRemaining = 0;
    forwardBehaviourForNewClients = 'succeed';
    pool = new JumpHostPool({
      createClient: () => {
        const client = new FakeSshClient();
        client.forwardOutBehaviour = forwardBehaviourForNewClients;
        clients.push(client);
        if (readyMode === 'auto') {
          setImmediate(() => {
            if (authFailuresRemaining > 0) {
              authFailuresRemaining -= 1;
              client.emit('error', new Error('All configured authentication methods failed'));
            } else {
              client.emit('ready');
            }
          });
        }
        return client as unknown as Client;
      },
      log: (line) => logLines.push(line),
    });
  });

  afterEach(() => {
    // Clears pending idle timers so the jest worker can exit.
    pool.dispose();
  });

  it('connects through the createClient factory with the dialer config plus keepalive options (Q23)', async () => {
    const handle = await pool.acquire(request());
    expect(clients).toHaveLength(1);
    expect(clients[0].connectConfig).toEqual(expect.objectContaining({
      host: 'bastion.example.com',
      port: 22,
      username: 'jump',
      password: 'secret',
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    }));
    expect(handle.key).toBe('jump@bastion.example.com:22');
    handle.release();
  });

  it('canonical key lowercases the hostname (Q27)', async () => {
    const handle = await pool.acquire({ ...request(), target: { ...target, host: 'Bastion.Example.COM' } });
    expect(handle.key).toBe('jump@bastion.example.com:22');
    handle.release();
  });

  it('second acquire of the same key reuses the live connection — no second dial', async () => {
    const first = await pool.acquire(request());
    const second = await pool.acquire(request());
    expect(clients).toHaveLength(1);
    first.release();
    second.release();
  });

  it('a different credential resolving to the same key reuses the first connection and logs it (R8-4)', async () => {
    const first = await pool.acquire(request('cred-a'));
    const second = await pool.acquire(request('cred-b'));
    expect(clients).toHaveLength(1);
    expect(logLines.some(line => line.includes('jump@bastion.example.com:22') && /first/i.test(line))).toBe(true);
    first.release();
    second.release();
  });

  it('concurrent acquires share one in-flight dial (Q26)', async () => {
    const [first, second] = await Promise.all([pool.acquire(request()), pool.acquire(request())]);
    expect(clients).toHaveLength(1);
    first.release();
    second.release();
  });

  it('a cancelled dial rejects every waiter and is not retried (Q26/R8-8)', async () => {
    readyMode = 'manual';
    const dialer: JumpHostDialer = {
      async prepare(_client, abortConnect) {
        setImmediate(() => abortConnect(new Error('Connection cancelled: the authentication prompt was dismissed')));
        return { host: target.host, port: target.port, username: target.username };
      },
    };
    const firstAttempt = pool.acquire({ target, sourceId: 'cred-a', dialer });
    const secondAttempt = pool.acquire({ target, sourceId: 'cred-a', dialer });
    await expect(firstAttempt).rejects.toThrow(/cancelled/i);
    await expect(secondAttempt).rejects.toThrow(/cancelled/i);
    expect(clients).toHaveLength(1);
  });

  it('an auth failure is retried once per acquirer (Q26/R8-8)', async () => {
    authFailuresRemaining = 1;
    const handle = await pool.acquire(request());
    expect(clients).toHaveLength(2);
    handle.release();
  });

  it('two auth failures in a row reject the acquire', async () => {
    authFailuresRemaining = 2;
    await expect(pool.acquire(request())).rejects.toThrow(/authentication methods failed/i);
    expect(clients).toHaveLength(2);
  });

  it('a non-auth connect error is not retried', async () => {
    readyMode = 'manual';
    const acquireAttempt = pool.acquire(request());
    await flushMicrotasks();
    clients[0].emit('error', new Error('connect ECONNREFUSED'));
    await expect(acquireAttempt).rejects.toThrow(/ECONNREFUSED/);
    expect(clients).toHaveLength(1);
  });

  it('last release closes the hop only after the 5-minute idle timeout', async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    try {
      const first = await pool.acquire(request());
      const second = await pool.acquire(request());
      first.release();
      second.release();
      expect(clients[0].ended).toBe(false);
      jest.advanceTimersByTime(JUMP_HOST_IDLE_TIMEOUT_MS - 1);
      expect(clients[0].ended).toBe(false);
      jest.advanceTimersByTime(1);
      expect(clients[0].ended).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-acquiring during the idle window cancels the close', async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    try {
      const first = await pool.acquire(request());
      first.release();
      const second = await pool.acquire(request());
      jest.advanceTimersByTime(JUMP_HOST_IDLE_TIMEOUT_MS * 2);
      expect(clients[0].ended).toBe(false);
      expect(clients).toHaveLength(1);
      second.release();
    } finally {
      jest.useRealTimers();
    }
  });

  it('an idle close does NOT fire onDidEvict', async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    try {
      const evicted: string[] = [];
      pool.onDidEvict((key) => evicted.push(key));
      const handle = await pool.acquire(request());
      handle.release();
      jest.advanceTimersByTime(JUMP_HOST_IDLE_TIMEOUT_MS);
      expect(clients[0].ended).toBe(true);
      expect(evicted).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an unexpected close evicts the hop and fires onDidEvict (Q14/Q34)', async () => {
    const evicted: string[] = [];
    pool.onDidEvict((key) => evicted.push(key));
    const handle = await pool.acquire(request());
    clients[0].emit('close');
    await flushMicrotasks();
    expect(evicted).toEqual(['jump@bastion.example.com:22']);
    // The next acquire dials fresh instead of returning the dead client.
    const fresh = await pool.acquire(request());
    expect(clients).toHaveLength(2);
    handle.release();
    fresh.release();
  });

  it('forwardOut opens a channel on the pooled client', async () => {
    const handle = await pool.acquire(request());
    const channel = await handle.forwardOut('127.0.0.1', 0, 'target.internal', 22);
    expect(clients[0].forwardOutCalls).toEqual([
      { sourceHost: '127.0.0.1', sourcePort: 0, destinationHost: 'target.internal', destinationPort: 22 },
    ]);
    expect((channel as unknown as { from: FakeSshClient }).from).toBe(clients[0]);
    handle.release();
  });

  it('a failed forwardOut re-dials once and retries — may re-prompt bastion MFA (Q23/R8-10)', async () => {
    const handle = await pool.acquire(request());
    clients[0].forwardOutBehaviour = 'fail';
    const channel = await handle.forwardOut('127.0.0.1', 0, 'target.internal', 22);
    expect(clients).toHaveLength(2);
    expect(clients[0].ended).toBe(true);
    expect((channel as unknown as { from: FakeSshClient }).from).toBe(clients[1]);
    expect(logLines.some(line => line.includes('re-authenticating to') && line.includes('bastion.example.com'))).toBe(true);
    handle.release();
  });

  it('a forwardOut that fails after the retry rejects', async () => {
    const handle = await pool.acquire(request());
    // Every client — the current one and the retry's replacement — fails its forwards.
    forwardBehaviourForNewClients = 'fail';
    clients[0].forwardOutBehaviour = 'fail';
    await expect(handle.forwardOut('127.0.0.1', 0, 'target.internal', 22)).rejects.toThrow(/Channel open failure/);
    expect(clients).toHaveLength(2);
    handle.release();
  });

  it('forwardOut on an evicted hop reconnects transparently', async () => {
    const handle = await pool.acquire(request());
    clients[0].emit('close');
    await flushMicrotasks();
    const channel = await handle.forwardOut('127.0.0.1', 0, 'target.internal', 22);
    expect(clients).toHaveLength(2);
    expect((channel as unknown as { from: FakeSshClient }).from).toBe(clients[1]);
    expect(logLines.some(line => line.includes('re-authenticating to'))).toBe(true);
    handle.release();
  });

  it('drain closes idle hops now and leaves held hops until their last release (R6)', async () => {
    const heldHandle = await pool.acquire(request());
    const idleHandle = await pool.acquire({
      ...request(),
      target: { username: 'jump', host: 'other.example.com', port: 22 },
    });
    idleHandle.release();
    // other.example.com is idle (in its 5-min window), bastion is held.
    pool.drain();
    await flushMicrotasks();
    expect(clients[1].ended).toBe(true);   // idle → closed now
    expect(clients[0].ended).toBe(false);  // held → survives drain
    heldHandle.release();
    expect(clients[0].ended).toBe(true);   // …and closes on last release, not after 5 min
  });

  it('drain does not fire onDidEvict for the hops it closes', async () => {
    const evicted: string[] = [];
    pool.onDidEvict((key) => evicted.push(key));
    const handle = await pool.acquire(request());
    handle.release();
    pool.drain();
    await flushMicrotasks();
    expect(evicted).toHaveLength(0);
  });

  // 18a-2b, H3/Q14: a saved/deleted credential invalidates its pooled hop —
  // the connection was authenticated with the OLD data. Unlike drain, this IS
  // an eviction: live holders' sessions ride the closed client, so onDidEvict
  // must fire for consumers (Remote Files) to react.
  describe('evictBySourceId', () => {
    it('closes the hop dialed with that credential and fires onDidEvict, even while held', async () => {
      const evicted: string[] = [];
      pool.onDidEvict((key) => evicted.push(key));
      const handle = await pool.acquire(request('cred-bastion'));
      pool.evictBySourceId('cred-bastion');
      await flushMicrotasks();
      expect(clients[0].ended).toBe(true);
      expect(evicted).toEqual(['jump@bastion.example.com:22']);
      handle.release();
    });

    it('leaves hops dialed with other credentials untouched', async () => {
      const evicted: string[] = [];
      pool.onDidEvict((key) => evicted.push(key));
      const handle = await pool.acquire(request('cred-bastion'));
      pool.evictBySourceId('cred-unrelated');
      await flushMicrotasks();
      expect(clients[0].ended).toBe(false);
      expect(evicted).toHaveLength(0);
      handle.release();
    });

    it('a fresh acquire after the eviction dials a new connection', async () => {
      const first = await pool.acquire(request('cred-bastion'));
      first.release();
      pool.evictBySourceId('cred-bastion');
      await flushMicrotasks();
      const second = await pool.acquire(request('cred-bastion'));
      expect(clients).toHaveLength(2);
      second.release();
    });
  });

  it('release is idempotent per handle', async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    try {
      const first = await pool.acquire(request());
      const second = await pool.acquire(request());
      first.release();
      first.release();
      first.release();
      // second still holds the hop — a triple-release of the first handle must not close it.
      jest.advanceTimersByTime(JUMP_HOST_IDLE_TIMEOUT_MS);
      expect(clients[0].ended).toBe(false);
      second.release();
    } finally {
      jest.useRealTimers();
    }
  });
});
