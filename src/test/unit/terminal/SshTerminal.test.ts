import { EventEmitter } from 'events';
import type { Client, ClientChannel, ConnectConfig, ExecOptions } from 'ssh2';
import { buildShellCommand, SshTerminal, SshTerminalDependencies, SshTerminalOptions } from '../../../terminal/SshTerminal';
import { JumpHostPool } from '../../../ssh/JumpHostPool';
import {
  ConnectProviders,
  KeyboardInteractiveCoordinator,
  KeyboardInteractiveProvider,
} from '../../../ssh/connectProviders';
import { SshCredentialWithSecret } from '../../../models/SshCredential';

// ─── Fakes ───────────────────────────────────────────────────────────────────

class FakeChannel extends EventEmitter {
  written: string[] = [];
  ended = false;
  windows: Array<{ rows: number; cols: number }> = [];
  stderr = new EventEmitter();

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  setWindow(rows: number, cols: number): void {
    this.windows.push({ rows, cols });
  }
}

type AuthBehaviour = 'ready' | 'auth-failure' | 'keyboard-interactive';

/** Target client: authenticates per `behaviour`, records exec calls, hands out FakeChannels. */
class FakeTargetClient extends EventEmitter {
  connectConfig: ConnectConfig | undefined;
  ended = false;
  execCalls: Array<{ command: string; options: ExecOptions }> = [];
  channel: FakeChannel | undefined;
  static behaviour: AuthBehaviour = 'ready';
  static execError: Error | undefined;

  connect(config: ConnectConfig): this {
    this.connectConfig = config;
    setImmediate(() => {
      switch (FakeTargetClient.behaviour) {
        case 'ready':
          this.emit('ready');
          return;
        case 'auth-failure':
          this.emit('error', new Error('All configured authentication methods failed'));
          return;
        case 'keyboard-interactive':
          this.emit('keyboard-interactive', 'login', '', '', [{ prompt: 'Verification code:', echo: false }], () => {
            this.emit('ready');
          });
          return;
      }
    });
    return this;
  }

  exec(command: string, options: ExecOptions, callback: (error: Error | undefined, channel: ClientChannel) => void): this {
    this.execCalls.push({ command, options });
    setImmediate(() => {
      if (FakeTargetClient.execError) {
        callback(FakeTargetClient.execError, undefined as unknown as ClientChannel);
        return;
      }
      this.channel = new FakeChannel();
      callback(undefined, this.channel as unknown as ClientChannel);
    });
    return this;
  }

  end(): this {
    this.ended = true;
    setImmediate(() => this.emit('close'));
    return this;
  }
}

/** Pooled hop client: always ready, forwards to a fake sock. */
class FakeHopClient extends EventEmitter {
  ended = false;
  forwardOutCalls: Array<{ destinationHost: string; destinationPort: number }> = [];

  connect(): this {
    setImmediate(() => this.emit('ready'));
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
    callback(undefined, { fakeSock: `${destinationHost}:${destinationPort}`, destroy: () => undefined } as unknown as ClientChannel);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const targetCredential: SshCredentialWithSecret = {
  id: 'cred-target', name: 'Target', host: 'target.example.com', port: 22,
  username: 'deploy', authMethod: 'password', password: 'deploy-secret',
};

const bastionCredential: SshCredentialWithSecret = {
  id: 'cred-bastion', name: 'Bastion', host: 'bastion.example.com', port: 2222,
  username: 'jump', authMethod: 'password', password: 'bastion-secret',
};

const BASTION_KEY = 'jump@bastion.example.com:2222';

function flush(times = 6): Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

describe('buildShellCommand', () => {
  it('cds into the directory quietly, then execs a login shell (R7)', () => {
    expect(buildShellCommand('/var/www')).toBe(
      'cd -- \'/var/www\' 2>/dev/null; exec "${SHELL:-/bin/sh}" -l'
    );
  });

  it('single-quotes paths with spaces, quotes, and shell metacharacters', () => {
    expect(buildShellCommand('/srv/my site/it\'s $HOME `pwd`')).toBe(
      'cd -- \'/srv/my site/it\'\\\'\'s $HOME `pwd`\' 2>/dev/null; exec "${SHELL:-/bin/sh}" -l'
    );
  });
});

describe('SshTerminal', () => {
  let targetClients: FakeTargetClient[];
  let hopClients: FakeHopClient[];
  let logLines: string[];
  let pool: JumpHostPool;
  let promptAnswer: string[] | null;
  let promptCount: number;
  let credentialResolutions: number;
  let resolveCredentialGate: (() => void) | undefined;

  const keyboardInteractiveProvider: KeyboardInteractiveProvider = {
    prompt: async () => {
      promptCount += 1;
      return promptAnswer;
    },
  };

  function providers(): ConnectProviders {
    return {
      keyboardInteractive: keyboardInteractiveProvider,
      hostKey: undefined,
      jumpHosts: {
        pool,
        resolveCredential: async (id) => (id === 'cred-bastion' ? bastionCredential : null),
      },
      log: (line) => logLines.push(line),
      warn: (message) => logLines.push(message),
    };
  }

  function dependencies(): SshTerminalDependencies {
    return {
      providers: providers(),
      coordinator: new KeyboardInteractiveCoordinator(),
      createClient: () => {
        const client = new FakeTargetClient();
        targetClients.push(client);
        return client as unknown as Client;
      },
    };
  }

  function options(overrides?: Partial<SshTerminalOptions> & { credential?: SshCredentialWithSecret }): SshTerminalOptions {
    const credential = overrides?.credential ?? targetCredential;
    return {
      serverName: 'Production',
      remotePath: '/var/www',
      route: 'local → deploy@target.example.com:22',
      resolveCredential: async () => {
        credentialResolutions += 1;
        if (resolveCredentialGate) {
          await new Promise<void>((resolve) => { resolveCredentialGate = resolve; });
        }
        return credential;
      },
      ...overrides,
    };
  }

  interface Harness {
    terminal: SshTerminal;
    writes: string[];
    closes: Array<number | void>;
  }

  function createTerminal(terminalOptions: SshTerminalOptions = options()): Harness {
    const terminal = new SshTerminal(terminalOptions, dependencies());
    const writes: string[] = [];
    const closes: Array<number | void> = [];
    terminal.onDidWrite((data) => writes.push(data));
    terminal.onDidClose((code) => closes.push(code));
    return { terminal, writes, closes };
  }

  async function openAndConnect(terminalOptions?: SshTerminalOptions, dimensions?: { columns: number; rows: number }): Promise<Harness & { client: FakeTargetClient; channel: FakeChannel }> {
    const harness = createTerminal(terminalOptions);
    harness.terminal.open(dimensions);
    await flush();
    const client = targetClients[targetClients.length - 1];
    if (!client?.channel) {
      throw new Error('terminal did not reach the exec stage');
    }
    return { ...harness, client, channel: client.channel };
  }

  beforeEach(() => {
    targetClients = [];
    hopClients = [];
    logLines = [];
    promptAnswer = ['123456'];
    promptCount = 0;
    credentialResolutions = 0;
    resolveCredentialGate = undefined;
    FakeTargetClient.behaviour = 'ready';
    FakeTargetClient.execError = undefined;
    pool = new JumpHostPool({
      createClient: () => {
        const client = new FakeHopClient();
        hopClients.push(client);
        return client as unknown as Client;
      },
      log: (line) => logLines.push(line),
    });
  });

  afterEach(() => {
    pool.dispose();
  });

  describe('opening', () => {
    it('shows the connecting banner immediately — before the credential even resolves', () => {
      resolveCredentialGate = () => undefined; // parks resolveCredential
      const { terminal, writes } = createTerminal();

      terminal.open({ columns: 120, rows: 40 });

      expect(writes).toEqual(['Connecting to Production via local → deploy@target.example.com:22…\r\n']);
      expect(credentialResolutions).toBe(1);
      expect(targetClients).toHaveLength(0);
    });

    it('execs the login shell in the remote directory over an xterm-256color pty sized to the tab', async () => {
      const { client } = await openAndConnect(options(), { columns: 132, rows: 43 });

      expect(client.execCalls).toEqual([{
        command: buildShellCommand('/var/www'),
        options: { pty: { term: 'xterm-256color', rows: 43, cols: 132 } },
      }]);
      expect(client.connectConfig).toEqual(expect.objectContaining({
        host: 'target.example.com', port: 22, username: 'deploy', password: 'deploy-secret',
      }));
      expect(client.connectConfig?.sock).toBeUndefined();
    });

    it('defaults the pty to 80×24 when VS Code passes no initial dimensions (R8-13)', async () => {
      const { client } = await openAndConnect(options(), undefined);

      expect(client.execCalls[0].options).toEqual({ pty: { term: 'xterm-256color', rows: 24, cols: 80 } });
    });

    it('uses a resize that arrives before the channel exists for the exec, and setWindow afterwards', async () => {
      resolveCredentialGate = () => undefined;
      const { terminal } = createTerminal();
      terminal.open({ columns: 80, rows: 24 });
      terminal.setDimensions({ columns: 100, rows: 30 });
      resolveCredentialGate!();
      await flush();
      const client = targetClients[0];

      expect(client.execCalls[0].options).toEqual({ pty: { term: 'xterm-256color', rows: 30, cols: 100 } });
      expect(client.channel?.windows).toEqual([]);

      terminal.setDimensions({ columns: 200, rows: 50 });
      expect(client.channel?.windows).toEqual([{ rows: 50, cols: 200 }]);
    });

    it('applies ~/.ssh/config resolution to a credential that opts in', async () => {
      // No config file for this alias in the test environment: the alias is
      // kept as the host — the point is that the resolution path runs
      // without throwing and the dial still happens.
      const { client } = await openAndConnect(options({ credential: { ...targetCredential, useSshConfig: true, host: 'fileferry-test-alias-that-does-not-exist' } }));

      expect(client.connectConfig?.host).toBe('fileferry-test-alias-that-does-not-exist');
    });
  });

  describe('data flow', () => {
    it('pipes channel output (stdout and stderr) to the terminal and terminal input to the channel', async () => {
      const { terminal, writes, channel } = await openAndConnect();
      writes.length = 0;

      channel.emit('data', Buffer.from('$ '));
      channel.stderr.emit('data', Buffer.from('warning\r\n'));
      terminal.handleInput('ls\r');

      expect(writes).toEqual(['$ ', 'warning\r\n']);
      expect(channel.written).toEqual(['ls\r']);
    });

    it('reassembles a multi-byte character split across two chunks', async () => {
      const { writes, channel } = await openAndConnect();
      writes.length = 0;
      const euro = Buffer.from('€');

      channel.emit('data', euro.subarray(0, 1));
      channel.emit('data', euro.subarray(1));

      expect(writes.join('')).toBe('€');
    });

    it('ignores input before the channel exists instead of throwing', () => {
      resolveCredentialGate = () => undefined;
      const { terminal } = createTerminal();
      terminal.open(undefined);

      expect(() => terminal.handleInput('x')).not.toThrow();
    });
  });

  describe('exit', () => {
    it('propagates the shell exit code — "exit" carries it, "close" ends the terminal', async () => {
      const { closes, client, channel } = await openAndConnect();

      channel.emit('exit', 3);
      expect(closes).toEqual([]);
      channel.emit('close');

      expect(closes).toEqual([3]);
      expect(client.ended).toBe(true);
    });

    it('closes with 1 when the channel closes without an exit status (killed by a signal)', async () => {
      const { closes, channel } = await openAndConnect();

      channel.emit('exit', null, 'HUP');
      channel.emit('close');

      expect(closes).toEqual([1]);
    });

    it('says so when the connection drops under the shell, and exits 1 on a keypress', async () => {
      const { terminal, writes, closes, client } = await openAndConnect();
      writes.length = 0;

      client.emit('close');

      expect(writes.join('')).toMatch(/connection closed/i);
      expect(writes.join('')).toContain('Press any key to close');
      expect(closes).toEqual([]);
      terminal.handleInput('x');
      expect(closes).toEqual([1]);
    });

    it('fires onDidClose once even if exit, channel close, and client close all arrive', async () => {
      const { closes, client, channel } = await openAndConnect();

      channel.emit('exit', 0);
      channel.emit('close');
      client.emit('close');

      expect(closes).toEqual([0]);
    });
  });

  // VS Code disposes an extension terminal the moment onDidClose fires, so a
  // message written just before it would never be seen (§K finding). After a
  // failure the tab therefore stays open — message + "Press any key to
  // close" — and the exit code 1 is delivered on the next keypress.
  describe('failures', () => {
    it('writes "Connection cancelled" when the prompt is dismissed after the tab opened, then exits 1 on a keypress (R8-12)', async () => {
      FakeTargetClient.behaviour = 'keyboard-interactive';
      promptAnswer = null;
      const keyboardCredential: SshCredentialWithSecret = { ...targetCredential, authMethod: 'keyboard-interactive', password: undefined };
      const { terminal, writes, closes } = createTerminal(options({ credential: keyboardCredential }));

      terminal.open(undefined);
      await flush();

      expect(writes.join('')).toContain('Connection cancelled');
      expect(writes.join('')).toContain('Press any key to close');
      expect(closes).toEqual([]);
      expect(targetClients[0].ended).toBe(true);
      // Dismissed once — no retry, no second prompt.
      expect(promptCount).toBe(1);

      terminal.handleInput('\r');
      expect(closes).toEqual([1]);
    });

    it('reports a failed login and exits 1 on a keypress', async () => {
      FakeTargetClient.behaviour = 'auth-failure';
      const { terminal, writes, closes } = createTerminal();

      terminal.open(undefined);
      await flush();

      expect(writes.join('')).toContain('All configured authentication methods failed');
      expect(closes).toEqual([]);
      terminal.handleInput('x');
      expect(closes).toEqual([1]);
    });

    it('reports a failed exec and exits 1 on a keypress', async () => {
      FakeTargetClient.execError = new Error('Unable to exec');
      const { terminal, writes, closes } = createTerminal();

      terminal.open(undefined);
      await flush();

      expect(writes.join('')).toContain('Unable to exec');
      expect(targetClients[0].ended).toBe(true);
      expect(closes).toEqual([]);
      terminal.handleInput('x');
      expect(closes).toEqual([1]);
    });

    it('reports a credential that cannot be loaded and exits 1 on a keypress', async () => {
      const { terminal, writes, closes } = createTerminal(options({
        resolveCredential: async () => { throw new Error('Credential not found: cred-target'); },
      }));

      terminal.open(undefined);
      await flush();

      expect(writes.join('')).toContain('Credential not found');
      expect(closes).toEqual([]);
      terminal.handleInput('x');
      expect(closes).toEqual([1]);
    });

    it('fires the deferred exit code only once however many keys are pressed', async () => {
      FakeTargetClient.behaviour = 'auth-failure';
      const { terminal, closes } = createTerminal();

      terminal.open(undefined);
      await flush();
      terminal.handleInput('a');
      terminal.handleInput('b');

      expect(closes).toEqual([1]);
    });

    it('needs no keypress when VS Code closes the held tab itself', async () => {
      FakeTargetClient.behaviour = 'auth-failure';
      const { terminal, closes } = createTerminal();

      terminal.open(undefined);
      await flush();
      terminal.close();
      terminal.handleInput('x');

      expect(closes).toEqual([]);
    });
  });

  describe('closing the tab', () => {
    it('ends the channel and the client', async () => {
      const { terminal, closes, client, channel } = await openAndConnect();

      terminal.close();

      expect(channel.ended).toBe(true);
      expect(client.ended).toBe(true);
      // VS Code closed us — no exit code to report back.
      expect(closes).toEqual([]);
    });

    it('aborts a dial still in progress and never writes to the tab afterwards', async () => {
      FakeTargetClient.behaviour = 'keyboard-interactive';
      let releasePrompt: ((answers: string[] | null) => void) | undefined;
      const parkedProvider: KeyboardInteractiveProvider = {
        prompt: (_request, context) => new Promise((resolve) => {
          releasePrompt = resolve;
          context.signal?.addEventListener('abort', () => resolve(null), { once: true });
        }),
      };
      const deps = dependencies();
      deps.providers.keyboardInteractive = parkedProvider;
      const keyboardCredential: SshCredentialWithSecret = { ...targetCredential, authMethod: 'keyboard-interactive', password: undefined };
      const terminal = new SshTerminal(options({ credential: keyboardCredential }), deps);
      const writes: string[] = [];
      const closes: Array<number | void> = [];
      terminal.onDidWrite((data) => writes.push(data));
      terminal.onDidClose((code) => closes.push(code));

      terminal.open(undefined);
      await flush();
      expect(releasePrompt).toBeDefined();
      writes.length = 0;

      terminal.close();
      await flush();

      expect(targetClients[0].ended).toBe(true);
      expect(writes).toEqual([]);
      expect(closes).toEqual([]);
    });
  });

  describe('through a jump-host chain', () => {
    const chainedCredential: SshCredentialWithSecret = { ...targetCredential, jumpHosts: ['cred-bastion'] };

    function chainedOptions(): SshTerminalOptions {
      return options({
        credential: chainedCredential,
        route: 'local → jump@bastion.example.com:2222 → deploy@target.example.com:22',
      });
    }

    it('dials the target over the hop\'s forward and logs the route', async () => {
      const { client } = await openAndConnect(chainedOptions());

      expect(hopClients).toHaveLength(1);
      expect(hopClients[0].forwardOutCalls).toEqual([{ destinationHost: 'target.example.com', destinationPort: 22 }]);
      expect(client.connectConfig?.sock).toEqual(expect.objectContaining({ fakeSock: 'target.example.com:22' }));
      expect(logLines).toContain('route: local → jump@bastion.example.com:2222 → deploy@target.example.com:22');
    });

    it('holds its hop lease: Disconnect\'s drain leaves the hop alive until the terminal closes (Q25)', async () => {
      const { terminal } = await openAndConnect(chainedOptions());

      pool.drain();
      await flush();
      expect(hopClients[0].ended).toBe(false);
      expect(logLines).toContain(`drain: jump host ${BASTION_KEY} is in use — will close on last release`);

      terminal.close();
      await flush();
      expect(hopClients[0].ended).toBe(true);
    });

    it('releases the hop lease when the shell exits', async () => {
      const { channel } = await openAndConnect(chainedOptions());
      pool.drain();

      channel.emit('exit', 0);
      channel.emit('close');
      await flush();

      expect(hopClients[0].ended).toBe(true);
    });

    it('reports "connection to <hop> lost" when a hop on its route is evicted, and exits 1 on a keypress (Q34)', async () => {
      const { terminal, writes, closes, client } = await openAndConnect(chainedOptions());
      writes.length = 0;

      pool.evictBySourceId('cred-bastion');
      await flush();

      expect(writes.join('')).toContain(`connection to ${BASTION_KEY} lost`);
      expect(client.ended).toBe(true);
      expect(closes).toEqual([]);
      terminal.handleInput('x');
      expect(closes).toEqual([1]);
    });

    it('ignores evictions of hops that are not on its route', async () => {
      const { writes, closes } = await openAndConnect(chainedOptions());
      writes.length = 0;
      const unrelatedTarget = { username: 'other', host: 'elsewhere.example.com', port: 22 };
      const unrelated = await pool.acquire({
        target: unrelatedTarget,
        sourceId: 'cred-other',
        dialer: { prepare: async () => ({ host: unrelatedTarget.host, port: 22, username: 'other' }) },
      });
      unrelated.release();

      pool.evictBySourceId('cred-other');
      await flush();

      expect(writes).toEqual([]);
      expect(closes).toEqual([]);
    });

    it('stops holding the lease when the dial through the chain fails', async () => {
      FakeTargetClient.behaviour = 'auth-failure';
      const { terminal, closes } = createTerminal(chainedOptions());

      terminal.open(undefined);
      await flush();
      pool.drain();
      await flush();

      // The lease is released at failure time — before the keypress that
      // delivers the exit code.
      expect(closes).toEqual([]);
      // Nobody holds the hop any more — drain closes it immediately.
      expect(hopClients[0].ended).toBe(true);
      terminal.handleInput('x');
      expect(closes).toEqual([1]);
    });
  });
});
