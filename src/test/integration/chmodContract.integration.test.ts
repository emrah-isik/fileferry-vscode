import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpService } from '../../sftpService';
import { FtpService } from '../../ftpService';
import { ServerConfig } from '../../types';

/**
 * Real-server contract tests for TransferService.chmod (feature 33e, L5).
 *
 * The panel chmod command reports whatever the service reports — so the
 * service must be honest. Two things the unit mocks cannot prove:
 *
 *   1. SFTP chmod actually lands: the mode is visible in a subsequent raw
 *      listing (rights.user/group/other).
 *   2. FTP `SITE CHMOD` on this server behaves, and — the 33e L2 pin — a
 *      FAILED chmod (missing path) REJECTS instead of being swallowed. Before
 *      33e, FtpService.chmod ate every failure; the panel command would have
 *      reported success on servers that rejected the command outright.
 *
 * Opt-in only (excluded from `npm test`). Run with: npm run test:integration
 * Requires both test containers — docker start fileferry-ssh fileferry-ftp.
 * Overrides: FILEFERRY_IT_* (SFTP) / FILEFERRY_FTP_IT_* (FTP).
 */

const SFTP_HOST = process.env.FILEFERRY_IT_HOST ?? '127.0.0.1';
const SFTP_PORT = Number(process.env.FILEFERRY_IT_PORT ?? '2222');
const SFTP_USER = process.env.FILEFERRY_IT_USER ?? 'testuser';
const SFTP_PASS = process.env.FILEFERRY_IT_PASS ?? 'testpass';

const FTP_HOST = process.env.FILEFERRY_FTP_IT_HOST ?? '127.0.0.1';
const FTP_PORT = Number(process.env.FILEFERRY_FTP_IT_PORT ?? '21');
const FTP_USER = process.env.FILEFERRY_FTP_IT_USER ?? 'testuser';
const FTP_PASS = process.env.FILEFERRY_FTP_IT_PASS ?? 'testpass';

const sftpServer: ServerConfig = {
  id: 'integration-33e-sftp',
  name: 'Integration 33e SFTP',
  type: 'sftp',
  host: SFTP_HOST,
  port: SFTP_PORT,
  username: SFTP_USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

const ftpServer: ServerConfig = {
  id: 'integration-33e-ftp',
  name: 'Integration 33e FTP',
  type: 'ftp',
  host: FTP_HOST,
  port: FTP_PORT,
  username: FTP_USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

describe('chmod contract — SFTP', () => {
  let service: SftpService;
  let localProbe: string;
  const remoteBase = `/tmp/.fileferry-33e-it-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    localProbe = path.join(os.tmpdir(), `fileferry-33e-it-${process.pid}.txt`);
    fs.writeFileSync(localProbe, 'probe');

    service = new SftpService();
    try {
      await service.connect(sftpServer, { password: SFTP_PASS }, { hostVerifier: () => true });
    } catch (err) {
      throw new Error(
        `Cannot reach the SFTP test container at ${SFTP_HOST}:${SFTP_PORT} (${(err as Error).message}).`
      );
    }
    await service.mkdir(remoteBase);
  });

  afterAll(async () => {
    try { await service.deleteDirectory(remoteBase); } catch { /* best effort cleanup */ }
    try { await service.disconnect(); } catch { /* ignore */ }
    try { fs.unlinkSync(localProbe); } catch { /* ignore */ }
  });

  async function modeOf(remoteDirectory: string, name: string): Promise<string | undefined> {
    const listing = await service.listDirectoryDetailed(remoteDirectory);
    const match = listing.find(item => item.name === name);
    expect(match).toBeDefined();
    // FileEntry.mode is derived from the server's listing (33e follow-up) —
    // the same value the chmod prompt prefills, so pin it end to end.
    return match!.mode;
  }

  it('chmod 600 lands and the listing-derived mode reports it', async () => {
    const remoteFile = `${remoteBase}/locked.txt`;
    await service.uploadFile(localProbe, remoteFile);

    await service.chmod(remoteFile, 0o600);

    await expect(modeOf(remoteBase, 'locked.txt')).resolves.toBe('600');
  });

  it('chmod 755 lands and the listing-derived mode reports it', async () => {
    const remoteFile = `${remoteBase}/exec.sh`;
    await service.uploadFile(localProbe, remoteFile);

    await service.chmod(remoteFile, 0o755);

    await expect(modeOf(remoteBase, 'exec.sh')).resolves.toBe('755');
  });

  it('chmod on a missing path rejects', async () => {
    await expect(service.chmod(`${remoteBase}/missing.txt`, 0o644)).rejects.toThrow();
  });
});

describe('chmod contract — FTP (SITE CHMOD, honest failures per 33e L2)', () => {
  let service: FtpService;
  let localProbe: string;
  const remoteBase = `/var/www/.fileferry-33e-ftp-it-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    localProbe = path.join(os.tmpdir(), `fileferry-33e-ftp-it-${process.pid}.txt`);
    fs.writeFileSync(localProbe, 'probe');

    service = new FtpService();
    try {
      await service.connect(ftpServer, { password: FTP_PASS });
    } catch (err) {
      throw new Error(
        `Cannot reach the FTP test container at ${FTP_HOST}:${FTP_PORT} (${(err as Error).message}).`
      );
    }
    await service.mkdir(remoteBase);
  });

  afterAll(async () => {
    try { await service.deleteDirectory(remoteBase); } catch { /* best effort cleanup */ }
    try { await service.disconnect(); } catch { /* ignore */ }
    try { fs.unlinkSync(localProbe); } catch { /* ignore */ }
  });

  it('SITE CHMOD on an existing file succeeds, and the listing-derived mode reports it', async () => {
    const remoteFile = `${remoteBase}/probe.txt`;
    await service.uploadFile(localProbe, remoteFile);

    await service.chmod(remoteFile, 0o600);

    const listing = await service.listDirectoryDetailed(remoteBase);
    const match = listing.find(item => item.name === 'probe.txt');
    expect(match).toBeDefined();
    // The container serves unix-style LIST output, so basic-ftp parses
    // permissions and FileEntry.mode carries them (33e follow-up).
    expect(match!.mode).toBe('600');
  });

  it('a failed SITE CHMOD (missing path) rejects — the pre-33e swallow is gone', async () => {
    await expect(service.chmod(`${remoteBase}/missing.txt`, 0o644)).rejects.toThrow();
  });
});
