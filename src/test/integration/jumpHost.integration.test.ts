import * as crypto from 'crypto';
import * as net from 'net';
import { SftpService } from '../../sftpService';
import { JumpHostPool } from '../../ssh/JumpHostPool';
import { connectProviderRegistry, KeyboardInteractiveRequest } from '../../ssh/connectProviders';
import { ServerConfig } from '../../types';
import { SshCredentialWithSecret } from '../../models/SshCredential';
import { Client as Ssh2Client } from 'ssh2';
import { describeIfFixtureUp, SSH_FIXTURE_START_HINT } from './fixtureProbe';

/**
 * Jump-host chain against the real compose fixture (18a-2a):
 * bastion published on 127.0.0.1:2222, target reachable ONLY through it
 * (internal-only docker network). See dev/ssh-test/docker-compose.yml.
 *
 * Opt-in like every integration suite (npm run test:integration); skips with
 * a message when the fixture is down (R8-15).
 */

const BASTION_HOST = process.env.FILEFERRY_IT_HOST ?? '127.0.0.1';
const BASTION_PORT = Number(process.env.FILEFERRY_IT_PORT ?? '2222');
const BASTION_USER = process.env.FILEFERRY_IT_USER ?? 'testuser';
const BASTION_PASS = process.env.FILEFERRY_IT_PASS ?? 'testpass';
const TARGET_HOST = process.env.FILEFERRY_IT_TARGET_HOST ?? 'target';
const TARGET_PORT = Number(process.env.FILEFERRY_IT_TARGET_PORT ?? '22');
const TARGET_USER = process.env.FILEFERRY_IT_TARGET_USER ?? 'deploy';
const TARGET_PASS = process.env.FILEFERRY_IT_TARGET_PASS ?? 'deploypass';

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // baked into the fixture's totpuser

jest.setTimeout(60000);

// R8-15: skip (never throw) when the fixture is down.
const describeIntegration = describeIfFixtureUp('SSH fixture (bastion)', BASTION_HOST, BASTION_PORT, SSH_FIXTURE_START_HINT);

// ─── helpers ─────────────────────────────────────────────────────────────────

const bastionCredential: SshCredentialWithSecret = {
  id: 'it-cred-bastion', name: 'IT Bastion', host: BASTION_HOST, port: BASTION_PORT,
  username: BASTION_USER, authMethod: 'password', password: BASTION_PASS,
};

function chainedServer(): ServerConfig {
  return {
    id: 'it-chained-target', name: 'IT Target', type: 'sftp',
    host: TARGET_HOST, port: TARGET_PORT, username: TARGET_USER, authMethod: 'password',
    jumpHosts: [bastionCredential.id],
    mappings: [], excludedPaths: [],
  };
}

function directBastionServer(username: string, authMethod: ServerConfig['authMethod'] = 'password'): ServerConfig {
  return {
    id: `it-bastion-${username}`, name: 'IT Bastion Direct', type: 'sftp',
    host: BASTION_HOST, port: BASTION_PORT, username, authMethod,
    mappings: [], excludedPaths: [],
  };
}

function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bitCount = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of encoded) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bytes.push((accumulator >>> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return (((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)).toString().padStart(6, '0');
}

function isTcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

describeIntegration('jump-host chain (compose fixture)', () => {
  let pool: JumpHostPool;
  let recordedRounds: KeyboardInteractiveRequest[];
  let keyboardAnswers: (request: KeyboardInteractiveRequest) => string[] | null;

  beforeEach(() => {
    recordedRounds = [];
    keyboardAnswers = () => null;
    pool = new JumpHostPool({ createClient: () => new Ssh2Client(), log: () => undefined });
    connectProviderRegistry.clear();
    connectProviderRegistry.set({
      log: () => undefined,
      keyboardInteractive: {
        prompt: async (request) => {
          recordedRounds.push(request);
          return keyboardAnswers(request);
        },
      },
      jumpHosts: {
        pool,
        resolveCredential: async (id) => (id === bastionCredential.id ? bastionCredential : null),
      },
    });
  });

  afterEach(() => {
    pool.dispose();
    connectProviderRegistry.clear();
  });

  beforeAll(async () => {
    // Guard against the OLD standalone fileferry-ssh container still owning
    // port 2222: only the compose bastion writes /var/log/sshd.log.
    const probeService = new SftpService();
    await probeService.connect(
      directBastionServer(BASTION_USER), { password: BASTION_PASS }, { interactive: true }
    );
    const hasComposeLog = await probeService.exists('/var/log/sshd.log');
    await probeService.disconnect();
    if (!hasComposeLog) {
      throw new Error(
        'The server on 127.0.0.1:2222 looks like the OLD fileferry-ssh container ' +
        '(no /var/log/sshd.log). Stop it and start the compose fixture: ' +
        'docker stop fileferry-ssh && docker compose -f dev/ssh-test/docker-compose.yml up -d --build'
      );
    }
  });

  it('reaches the target through the bastion (marker file exists only there)', async () => {
    const service = new SftpService();
    await service.connect(chainedServer(), { password: TARGET_PASS });
    const listing = await service.listDirectory('/var/www');
    expect(listing.map(entry => entry.name)).toContain('target-marker.txt');
    await service.disconnect();
  });

  it('two chained sessions share ONE bastion login (Q7/Q13)', async () => {
    const logReader = new SftpService();
    await logReader.connect(directBastionServer(BASTION_USER), { password: BASTION_PASS });
    const countAccepted = async (): Promise<number> => {
      const log = (await logReader.get('/var/log/sshd.log')).toString();
      return log.split('\n').filter(line => line.includes(`Accepted password for ${BASTION_USER}`)).length;
    };
    const baseline = await countAccepted();

    const firstSession = new SftpService();
    const secondSession = new SftpService();
    await firstSession.connect(chainedServer(), { password: TARGET_PASS });
    await secondSession.connect(chainedServer(), { password: TARGET_PASS });
    expect(await countAccepted()).toBe(baseline + 1);

    await firstSession.disconnect();
    await secondSession.disconnect();
    await logReader.disconnect();
  });

  it('exec runs on the TARGET through the hop', async () => {
    const service = new SftpService();
    await service.connect(chainedServer(), { password: TARGET_PASS });
    const result = await service.execCommand('cat /var/www/target-marker.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('only on the target');
    await service.disconnect();
  });

  it('a killed bastion connection is evicted, and the next chained connect re-authenticates (Q14/R8-10)', async () => {
    const evicted: string[] = [];
    pool.onDidEvict((key) => evicted.push(key));

    const service = new SftpService();
    await service.connect(chainedServer(), { password: TARGET_PASS });

    // Kill the pool's bastion session server-side. The killer session dies
    // with it (same user), so fire the pkill delayed and detached.
    const killer = new SftpService();
    await killer.connect(directBastionServer(BASTION_USER), { password: BASTION_PASS });
    await killer.execCommand("sh -c 'nohup sh -c \"sleep 1; pkill -U testuser -x sshd\" >/dev/null 2>&1 &'");
    await killer.disconnect().catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(evicted).toContain(`${BASTION_USER}@${BASTION_HOST}:${BASTION_PORT}`);

    // A fresh chained connect after the eviction dials the bastion anew.
    const reconnected = new SftpService();
    await reconnected.connect(chainedServer(), { password: TARGET_PASS });
    const listing = await reconnected.listDirectory('/var/www');
    expect(listing.map(entry => entry.name)).toContain('target-marker.txt');
    await reconnected.disconnect();
    await service.disconnect().catch(() => undefined);
  });

  it('mfauser logs in through MULTI-ROUND keyboard-interactive (fixed OTP, then password)', async () => {
    keyboardAnswers = (request) => (request.round === 1 ? ['123456'] : ['mfapass']);
    const service = new SftpService();
    await service.connect(directBastionServer('mfauser', 'keyboard-interactive'), {});
    expect(service.connected).toBe(true);
    expect(recordedRounds.length).toBeGreaterThanOrEqual(2); // pam_exec round + pam_unix round
    await service.disconnect();
  });

  it('totpuser: a REUSED verification code is rejected (DISALLOW_REUSE)', async () => {
    const code = totpCode(TOTP_SECRET);
    keyboardAnswers = (request) =>
      /verification/i.test(request.prompts.map(prompt => prompt.prompt).join(' ')) ? [code] : ['totppass'];

    const firstLogin = new SftpService();
    await firstLogin.connect(directBastionServer('totpuser', 'keyboard-interactive'), {});
    expect(firstLogin.connected).toBe(true);
    await firstLogin.disconnect();

    // Same code again: rejected as reuse (or expired if the window rolled —
    // either way the replay must NOT authenticate).
    const replayLogin = new SftpService();
    await expect(
      replayLogin.connect(directBastionServer('totpuser', 'keyboard-interactive'), {})
    ).rejects.toThrow();
    expect(replayLogin.connected).toBe(false);
  });

  it('the target is NOT reachable from the host directly (internal-only network)', async () => {
    const service = new SftpService();
    await service.connect(chainedServer(), { password: TARGET_PASS });
    const addressResult = await service.execCommand('hostname -i');
    await service.disconnect();
    expect(addressResult.exitCode).toBe(0);
    const targetAddress = addressResult.stdout.trim().split(/\s+/)[0];
    expect(targetAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(await isTcpReachable(targetAddress, TARGET_PORT)).toBe(false);
  });
});
