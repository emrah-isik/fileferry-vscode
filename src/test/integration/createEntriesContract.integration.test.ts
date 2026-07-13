import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpService } from '../../sftpService';
import { FtpService } from '../../ftpService';
import { ServerConfig } from '../../types';

/**
 * Real-server contract tests for TransferService.mkdir/exists (feature 32b).
 *
 * The create-file / create-folder commands decide "is there already something
 * here?" purely from exists(), and create folders through mkdir(). The unit
 * tests mock both, so they prove the calling logic — not that the primitives
 * behave. These tests pin the assumptions against real servers:
 *
 *   1. exists() is false for a missing path, true after mkdir()   (both transports)
 *   2. exists() sees plain files too, not just directories        (both transports)
 *   3. SFTP mkdir() is non-recursive by default (missing parent → error)
 *   4. FTP mkdir() (basic-ftp ensureDir) creates missing parents AND changes
 *      the client's working directory — the documented caveat at
 *      FtpService.mkdir. Absolute-path operations must keep working after it.
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
  id: 'integration-32b-sftp',
  name: 'Integration 32b SFTP',
  type: 'sftp',
  host: SFTP_HOST,
  port: SFTP_PORT,
  username: SFTP_USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

const ftpServer: ServerConfig = {
  id: 'integration-32b-ftp',
  name: 'Integration 32b FTP',
  type: 'ftp',
  host: FTP_HOST,
  port: FTP_PORT,
  username: FTP_USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

describe('mkdir/exists contract — SFTP', () => {
  let service: SftpService;
  let localProbe: string;
  const remoteBase = `/tmp/.fileferry-32b-it-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    localProbe = path.join(os.tmpdir(), `fileferry-32b-it-${process.pid}.txt`);
    fs.writeFileSync(localProbe, '');

    service = new SftpService();
    try {
      await service.connect(sftpServer, { password: SFTP_PASS }, { hostVerifier: () => true });
    } catch (err) {
      throw new Error(
        `Cannot reach the SFTP test container at ${SFTP_HOST}:${SFTP_PORT} (${(err as Error).message}).`
      );
    }
  });

  afterAll(async () => {
    try { await service.deleteDirectory(remoteBase); } catch { /* best effort cleanup */ }
    try { await service.disconnect(); } catch { /* ignore */ }
    try { fs.unlinkSync(localProbe); } catch { /* ignore */ }
  });

  it('exists() is false for a missing path, true after mkdir(), and the entry is a directory', async () => {
    const remoteDirectory = `${remoteBase}/newdir`;
    await expect(service.exists(remoteDirectory)).resolves.toBe(false);

    await service.mkdir(remoteBase);
    await service.mkdir(remoteDirectory);

    await expect(service.exists(remoteDirectory)).resolves.toBe(true);
    await expect(service.statType(remoteDirectory)).resolves.toBe('d');
  });

  it('exists() sees a plain file, not just directories', async () => {
    const remoteFile = `${remoteBase}/probe.txt`;
    await expect(service.exists(remoteFile)).resolves.toBe(false);

    await service.uploadFile(localProbe, remoteFile);

    await expect(service.exists(remoteFile)).resolves.toBe(true);
    await expect(service.statType(remoteFile)).resolves.toBe('-');
  });

  it('mkdir() is non-recursive by default — a missing parent is an error, not a silent create', async () => {
    const orphan = `${remoteBase}/missing-parent/child`;
    await expect(service.mkdir(orphan)).rejects.toThrow();
    await expect(service.exists(orphan)).resolves.toBe(false);
  });

  it('mkdir(recursive) creates the missing parents', async () => {
    const nested = `${remoteBase}/deep/nested/dir`;
    await service.mkdir(nested, true);
    await expect(service.exists(nested)).resolves.toBe(true);
  });
});

describe('mkdir/exists contract — FTP (basic-ftp ensureDir caveat)', () => {
  let service: FtpService;
  let localProbe: string;
  const remoteBase = `/var/www/.fileferry-32b-ftp-it-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    localProbe = path.join(os.tmpdir(), `fileferry-32b-ftp-it-${process.pid}.txt`);
    fs.writeFileSync(localProbe, '');

    service = new FtpService();
    try {
      await service.connect(ftpServer, { password: FTP_PASS });
    } catch (err) {
      throw new Error(
        `Cannot reach the FTP test container at ${FTP_HOST}:${FTP_PORT} (${(err as Error).message}).`
      );
    }
  });

  afterAll(async () => {
    try { await service.deleteDirectory(remoteBase); } catch { /* best effort cleanup */ }
    try { await service.disconnect(); } catch { /* ignore */ }
    try { fs.unlinkSync(localProbe); } catch { /* ignore */ }
  });

  it('exists() is false for a missing path, true after mkdir(), and the entry is a directory', async () => {
    const remoteDirectory = `${remoteBase}/newdir`;
    await expect(service.exists(remoteDirectory)).resolves.toBe(false);

    await service.mkdir(remoteDirectory);

    await expect(service.exists(remoteDirectory)).resolves.toBe(true);
    await expect(service.statType(remoteDirectory)).resolves.toBe('d');
  });

  it('mkdir() creates missing parents (ensureDir semantics — the documented caveat)', async () => {
    const nested = `${remoteBase}/parent-a/parent-b/child`;
    await expect(service.exists(`${remoteBase}/parent-a`)).resolves.toBe(false);

    await service.mkdir(nested);

    await expect(service.exists(nested)).resolves.toBe(true);
  });

  it('mkdir() changes the working directory, and absolute-path operations still work after it', async () => {
    const remoteDirectory = `${remoteBase}/cwd-probe`;
    await service.mkdir(remoteDirectory);

    // ensureDir leaves the client cd'd into the directory it created — the
    // second half of the documented caveat.
    await expect(service.resolveRemotePath('.')).resolves.toBe(remoteDirectory);

    // FileFerry only ever uses absolute remote paths, so the changed working
    // directory must be harmless: an upload + exists() elsewhere still lands
    // at the absolute location.
    const remoteFile = `${remoteBase}/after-cwd-change.txt`;
    await service.uploadFile(localProbe, remoteFile);
    await expect(service.exists(remoteFile)).resolves.toBe(true);
  });

  it('exists() sees a plain file, not just directories', async () => {
    const remoteFile = `${remoteBase}/probe.txt`;
    await service.uploadFile(localProbe, remoteFile);
    await expect(service.exists(remoteFile)).resolves.toBe(true);
    await expect(service.statType(remoteFile)).resolves.toBe('-');
  });
});
