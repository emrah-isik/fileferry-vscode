import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpService } from '../../sftpService';
import { FtpService } from '../../ftpService';
import { ServerConfig } from '../../types';

/**
 * Real-server contract tests for the remote-edit conflict signal (feature 32a).
 *
 * The save listener decides "did the remote change since I downloaded it?" purely
 * from stat().mtime deltas. The unit tests mock that signal, so they prove the
 * decision logic — not that the signal exists. These tests pin the three
 * assumptions the feature stands on, against real servers:
 *
 *   1. touching a remote file moves stat().mtime          (forced-conflict path)
 *   2. re-uploading a file moves stat().mtime forward     (post-upload baseline refresh)
 *   3. FTP's MDTM mtime is second-granular                (the documented D5 gap)
 *
 * Opt-in only (excluded from `npm test`). Run with: npm run test:integration
 * Requires both test containers — see the sibling integration tests for the
 * docker commands. Overrides: FILEFERRY_IT_* (SFTP) / FILEFERRY_FTP_IT_* (FTP).
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
  id: 'integration-32a-sftp',
  name: 'Integration 32a SFTP',
  type: 'sftp',
  host: SFTP_HOST,
  port: SFTP_PORT,
  username: SFTP_USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

const ftpServer: ServerConfig = {
  id: 'integration-32a-ftp',
  name: 'Integration 32a FTP',
  type: 'ftp',
  host: FTP_HOST,
  port: FTP_PORT,
  username: FTP_USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

function waitMilliseconds(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

describe('remote-edit conflict signal — SFTP', () => {
  let service: SftpService;
  let localProbe: string;
  const remoteProbe = `/tmp/.fileferry-32a-it-${process.pid}-${Date.now()}.txt`;

  beforeAll(async () => {
    localProbe = path.join(os.tmpdir(), `fileferry-32a-it-${process.pid}.txt`);
    fs.writeFileSync(localProbe, 'remote edit probe\n');

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
    try { await service.deleteFile(remoteProbe); } catch { /* best effort cleanup */ }
    try { await service.disconnect(); } catch { /* ignore */ }
    try { fs.unlinkSync(localProbe); } catch { /* ignore */ }
  });

  it('touch on the server moves stat().mtime — the forced-conflict signal', async () => {
    await service.uploadFile(localProbe, remoteProbe);
    const baseline = await service.stat(remoteProbe);
    expect(baseline).not.toBeNull();

    // mtime granularity is one second on both transports — make sure the
    // touch cannot land inside the same second as the upload.
    await waitMilliseconds(1100);
    const result = await service.execCommand(`touch ${remoteProbe}`);
    expect(result.exitCode).toBe(0);

    const touched = await service.stat(remoteProbe);
    expect(touched).not.toBeNull();
    expect(touched!.mtime.getTime()).not.toBe(baseline!.mtime.getTime());
  });

  it('re-uploading moves stat().mtime forward — the post-upload baseline refresh is meaningful', async () => {
    await service.uploadFile(localProbe, remoteProbe);
    const beforeUpload = await service.stat(remoteProbe);

    await waitMilliseconds(1100);
    await service.uploadFile(localProbe, remoteProbe);
    const afterUpload = await service.stat(remoteProbe);

    expect(afterUpload!.mtime.getTime()).toBeGreaterThan(beforeUpload!.mtime.getTime());
  });
});

describe('remote-edit conflict signal — FTP', () => {
  let service: FtpService;
  let localProbe: string;
  const remoteProbe = `/var/www/.fileferry-32a-ftp-it-${process.pid}-${Date.now()}.txt`;

  beforeAll(async () => {
    localProbe = path.join(os.tmpdir(), `fileferry-32a-ftp-it-${process.pid}.txt`);
    fs.writeFileSync(localProbe, 'remote edit ftp probe\n');

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
    try { await service.deleteFile(remoteProbe); } catch { /* best effort cleanup */ }
    try { await service.disconnect(); } catch { /* ignore */ }
    try { fs.unlinkSync(localProbe); } catch { /* ignore */ }
  });

  it('mtime is second-granular — the documented D5 gap is real, not narrower', async () => {
    await service.uploadFile(localProbe, remoteProbe);
    const result = await service.stat(remoteProbe);

    expect(result).not.toBeNull();
    const mtimeMs = result!.mtime.getTime();
    expect(Number.isNaN(mtimeMs)).toBe(false);
    // MDTM reports whole seconds; a sub-second component would mean the
    // guarantee is stronger than documented (fine) — but a NaN or wildly
    // scaled value would mean the conflict signal is broken on FTP.
    expect(mtimeMs % 1000).toBe(0);
    expect(Math.abs(mtimeMs - Date.now())).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('re-uploading moves stat().mtime forward — the conflict signal works over FTP', async () => {
    await service.uploadFile(localProbe, remoteProbe);
    const beforeUpload = await service.stat(remoteProbe);

    await waitMilliseconds(1100);
    await service.uploadFile(localProbe, remoteProbe);
    const afterUpload = await service.stat(remoteProbe);

    expect(afterUpload!.mtime.getTime()).toBeGreaterThan(beforeUpload!.mtime.getTime());
  });
});
