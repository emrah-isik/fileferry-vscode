import * as net from 'net';
import { Client as Ssh2Client, Server as Ssh2Server, utils as ssh2Utils } from 'ssh2';
import type { Connection, PseudoTtyInfo, WindowChangeInfo } from 'ssh2';
import { SshTerminal, TERMINAL_TYPE, buildShellCommand } from '../../../terminal/SshTerminal';
import { JumpHostPool } from '../../../ssh/JumpHostPool';
import { KeyboardInteractiveCoordinator } from '../../../ssh/connectProviders';
import { SshCredentialWithSecret } from '../../../models/SshCredential';

/**
 * Wire-level check of the terminal against ssh2's own in-process Server: the
 * pieces the fakes cannot prove — that a real sshd-side session receives our
 * pty request with the tab's size, the exact exec command, window-change on
 * resize, input bytes, and that the channel's exit status reaches
 * onDidClose. The chained case rides a real bastion forward.
 */

jest.setTimeout(20000);

const hostKey = ssh2Utils.generateKeyPairSync('ed25519');

interface TestServer {
  server: Ssh2Server;
  port: number;
  close(): Promise<void>;
}

function listen(server: Ssh2Server): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        server,
        port: address.port,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

interface SessionRecord {
  pty: PseudoTtyInfo | undefined;
  command: string | undefined;
  windowChanges: WindowChangeInfo[];
  received: string;
}

/**
 * Target: password auth; the session accepts a pty and an exec, echoes what
 * it receives, and exits with status 7 when it sees "exit".
 */
function createTarget(record: SessionRecord): Ssh2Server {
  return new Ssh2Server({ hostKeys: [hostKey.private] }, (connection: Connection) => {
    connection.on('authentication', (context) => {
      if (context.method === 'password' && context.password === 'target-pass') {
        context.accept();
        return;
      }
      context.reject(['password']);
    });
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept, _reject, info) => {
          record.pty = info;
          accept?.();
        });
        session.on('window-change', (accept, _reject, info) => {
          record.windowChanges.push(info);
          accept?.();
        });
        session.on('exec', (accept, _reject, info) => {
          record.command = info.command;
          const stream = accept();
          stream.write('shell ready\r\n');
          stream.on('data', (data: Buffer) => {
            record.received += data.toString();
            if (record.received.includes('exit')) {
              stream.exit(7);
              stream.end();
              return;
            }
            stream.write(data);
          });
        });
      });
    });
  });
}

/** Bastion: password auth, forwards direct-tcpip channels to their destination. */
function createBastion(onAuthAttempt: () => void): Ssh2Server {
  return new Ssh2Server({ hostKeys: [hostKey.private] }, (connection: Connection) => {
    connection.on('authentication', (context) => {
      if (context.method === 'password') {
        onAuthAttempt();
        if (context.password === 'bastion-pass') {
          context.accept();
          return;
        }
      }
      context.reject(['password']);
    });
    connection.on('ready', () => {
      connection.on('tcpip', (accept, _reject, info) => {
        const channel = accept();
        const socket = net.connect(info.destPort, info.destIP);
        socket.on('connect', () => {
          channel.pipe(socket);
          socket.pipe(channel);
        });
        socket.on('error', () => channel.end());
        channel.on('close', () => socket.destroy());
      });
    });
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('timed out waiting for the condition'));
      } else {
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}

describe('SshTerminal wire test (in-process ssh2 servers)', () => {
  let target: TestServer;
  let bastion: TestServer;
  let bastionAuthAttempts: number;
  let record: SessionRecord;
  let pool: JumpHostPool;
  let bastionCredential: SshCredentialWithSecret;

  function terminalFor(credential: SshCredentialWithSecret, remotePath: string): {
    terminal: SshTerminal;
    writes: string[];
    closes: Array<number | void>;
  } {
    const terminal = new SshTerminal(
      {
        serverName: 'Wire',
        remotePath,
        route: 'local → wire',
        resolveCredential: async () => credential,
      },
      {
        providers: {
          log: () => undefined,
          warn: () => undefined,
          jumpHosts: {
            pool,
            resolveCredential: async (id) => (id === 'cred-bastion' ? bastionCredential : null),
          },
        },
        coordinator: new KeyboardInteractiveCoordinator(),
        createClient: () => new Ssh2Client(),
      }
    );
    const writes: string[] = [];
    const closes: Array<number | void> = [];
    terminal.onDidWrite((data) => writes.push(data));
    terminal.onDidClose((code) => closes.push(code));
    return { terminal, writes, closes };
  }

  beforeEach(async () => {
    record = { pty: undefined, command: undefined, windowChanges: [], received: '' };
    bastionAuthAttempts = 0;
    target = await listen(createTarget(record));
    bastion = await listen(createBastion(() => { bastionAuthAttempts += 1; }));
    pool = new JumpHostPool({ createClient: () => new Ssh2Client(), log: () => undefined });
    bastionCredential = {
      id: 'cred-bastion', name: 'Wire Bastion', host: '127.0.0.1', port: bastion.port,
      username: 'jumpuser', authMethod: 'password', password: 'bastion-pass',
    };
  });

  afterEach(async () => {
    pool.dispose();
    await target.close();
    await bastion.close();
  });

  it('runs the login-shell exec on a pty sized to the tab, pipes both ways, and reports the exit status', async () => {
    const credential: SshCredentialWithSecret = {
      id: 'cred-target', name: 'Wire Target', host: '127.0.0.1', port: target.port,
      username: 'deploy', authMethod: 'password', password: 'target-pass',
    };
    const { terminal, writes, closes } = terminalFor(credential, '/srv/my app');

    terminal.open({ columns: 132, rows: 43 });
    await waitFor(() => writes.join('').includes('shell ready'));

    expect(record.pty).toEqual(expect.objectContaining({ term: TERMINAL_TYPE, cols: 132, rows: 43 }));
    expect(record.command).toBe(buildShellCommand('/srv/my app'));

    terminal.handleInput('echo hi\r');
    await waitFor(() => writes.join('').includes('echo hi\r'));

    terminal.setDimensions({ columns: 200, rows: 50 });
    await waitFor(() => record.windowChanges.length === 1);
    expect(record.windowChanges[0]).toEqual(expect.objectContaining({ cols: 200, rows: 50 }));

    terminal.handleInput('exit\r');
    await waitFor(() => closes.length === 1);
    expect(closes).toEqual([7]);
  });

  it('reaches the target through a real bastion forward, holding the hop until the shell exits', async () => {
    const credential: SshCredentialWithSecret = {
      id: 'cred-target', name: 'Wire Target', host: '127.0.0.1', port: target.port,
      username: 'deploy', authMethod: 'password', password: 'target-pass',
      jumpHosts: ['cred-bastion'],
    };
    const { terminal, writes, closes } = terminalFor(credential, '/var/www');

    terminal.open(undefined);
    await waitFor(() => writes.join('').includes('shell ready'));

    expect(bastionAuthAttempts).toBe(1);
    expect(record.pty).toEqual(expect.objectContaining({ term: TERMINAL_TYPE, cols: 80, rows: 24 }));
    expect(record.command).toBe(buildShellCommand('/var/www'));

    // Q25: a drain while the shell is open must not cut the hop under it.
    pool.drain();
    terminal.handleInput('still here\r');
    await waitFor(() => writes.join('').includes('still here\r'));

    terminal.handleInput('exit\r');
    await waitFor(() => closes.length === 1);
    expect(closes).toEqual([7]);
  });
});
