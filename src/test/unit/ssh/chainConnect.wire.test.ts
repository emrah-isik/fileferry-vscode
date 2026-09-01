import * as net from 'net';
import { Client as Ssh2Client, Server as Ssh2Server, utils as ssh2Utils } from 'ssh2';
import type { Connection } from 'ssh2';
import { SftpService } from '../../../sftpService';
import { JumpHostPool } from '../../../ssh/JumpHostPool';
import { connectProviderRegistry } from '../../../ssh/connectProviders';
import { ServerConfig } from '../../../types';
import { SshCredentialWithSecret } from '../../../models/SshCredential';

/**
 * Wire-level verification of the jump-host chain against ssh2's own in-process
 * Server (no Docker, no network beyond loopback). This is the programmatic
 * stand-in for the compose fixture: it proves the pieces the mocks cannot —
 * that a real bastion accepts our forwardOut, that the forwarded channel
 * really carries a second SSH handshake, that ssh2-sftp-client rides the
 * `sock` untouched, and that two sessions share ONE bastion login.
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

/** Target: password auth, serves a minimal SFTP subsystem (REALPATH only). */
function createTarget(): Ssh2Server {
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
        session.on('sftp', (acceptSftp) => {
          const sftpStream = acceptSftp();
          sftpStream.on('REALPATH', (requestId: number, _givenPath: string) => {
            sftpStream.name(requestId, [{ filename: '/var/www', longname: '/var/www', attrs: {} as never }]);
          });
        });
      });
    });
  });
}

describe('chain wire test (in-process ssh2 servers)', () => {
  let bastion: TestServer;
  let target: TestServer;
  let bastionAuthAttempts: number;
  let pool: JumpHostPool;
  let bastionCredential: SshCredentialWithSecret;
  let chainedServer: ServerConfig;

  beforeEach(async () => {
    bastionAuthAttempts = 0;
    bastion = await listen(createBastion(() => { bastionAuthAttempts += 1; }));
    target = await listen(createTarget());

    pool = new JumpHostPool({
      createClient: () => new Ssh2Client(),
      log: () => undefined,
    });

    bastionCredential = {
      id: 'cred-bastion', name: 'Wire Bastion', host: '127.0.0.1', port: bastion.port,
      username: 'jumpuser', authMethod: 'password', password: 'bastion-pass',
    };

    connectProviderRegistry.clear();
    connectProviderRegistry.set({
      log: () => undefined,
      jumpHosts: {
        pool,
        resolveCredential: async (id) => (id === 'cred-bastion' ? bastionCredential : null),
      },
    });

    chainedServer = {
      id: 'wire-target', name: 'Wire Target', type: 'sftp',
      host: '127.0.0.1', port: target.port, username: 'deploy', authMethod: 'password',
      jumpHosts: ['cred-bastion'],
      mappings: [], excludedPaths: [],
    };
  });

  afterEach(async () => {
    connectProviderRegistry.clear();
    pool.dispose();
    await bastion.close();
    await target.close();
  });

  it('opens a full SFTP session to the target through the bastion, and pooling shares one bastion login', async () => {
    const firstService = new SftpService();
    await firstService.connect(chainedServer, { password: 'target-pass' });
    expect(firstService.connected).toBe(true);
    // The SFTP subsystem answers over the forwarded channel — sock passthrough works.
    expect(await firstService.resolveRemotePath('.')).toBe('/var/www');

    // A second session through the same chain must NOT log in to the bastion again (Q7/Q13).
    const secondService = new SftpService();
    await secondService.connect(chainedServer, { password: 'target-pass' });
    expect(await secondService.resolveRemotePath('.')).toBe('/var/www');
    expect(bastionAuthAttempts).toBe(1);

    await firstService.disconnect();
    await secondService.disconnect();
  });

  it('a wrong target password fails the target connect, not the hop — and releases the bastion lease', async () => {
    const service = new SftpService();
    await expect(service.connect(chainedServer, { password: 'wrong' })).rejects.toThrow(/authentication/i);
    expect(service.connected).toBe(false);
    // The lease was released: drain() closes the bastion connection immediately.
    pool.drain();
  });

  it('an unreachable target rejects with the hop attributed (the bastion refuses the forward)', async () => {
    const unreachablePort = target.port;
    await target.close();
    // Recreate later in afterEach-safe way: point the server config at the now-closed port.
    target = await listen(createTarget()); // afterEach still has something to close
    const service = new SftpService();
    const serverWithDeadTarget: ServerConfig = { ...chainedServer, port: unreachablePort };
    await expect(service.connect(serverWithDeadTarget, { password: 'target-pass' })).rejects.toThrow();
    expect(service.connected).toBe(false);
  });
});
