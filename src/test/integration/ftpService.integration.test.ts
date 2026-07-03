import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FtpService } from '../../ftpService';
import { ServerConfig } from '../../types';

/**
 * Real-server contract test for FtpService — the deploy transport for FTP/FTPS
 * servers. The unit tests mock basic-ftp, so they only prove the code matches our
 * *assumption* about the library; this exercises an actual FTP server end-to-end.
 *
 * This is the test that backs feature #27 Option A: deploys now route through the
 * server's own transport (FtpService for FTP) instead of always SftpService, so
 * the FtpService upload/stat/list/delete path is exercised for real for the first
 * time.
 *
 * Opt-in only (excluded from `npm test`). Run with: npm run test:integration
 * Requires the FTP test container — start it with:
 *   docker run -d --name fileferry-ftp \
 *     -p 21:21 -p 21100-21110:21100-21110 \
 *     -e USERS="testuser|testpass|/var/www" \
 *     -e ADDRESS=127.0.0.1 -e MIN_PORT=21100 -e MAX_PORT=21110 \
 *     delfer/alpine-ftp-server
 * Connection details can be overridden via FILEFERRY_FTP_IT_HOST/PORT/USER/PASS.
 */

const HOST = process.env.FILEFERRY_FTP_IT_HOST ?? '127.0.0.1';
const PORT = Number(process.env.FILEFERRY_FTP_IT_PORT ?? '21');
const USER = process.env.FILEFERRY_FTP_IT_USER ?? 'testuser';
const PASS = process.env.FILEFERRY_FTP_IT_PASS ?? 'testpass';

const server: ServerConfig = {
  id: 'integration-ftp',
  name: 'Integration FTP',
  type: 'ftp',
  host: HOST,
  port: PORT,
  username: USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

describe('FtpService integration (real FTP server)', () => {
  let service: FtpService;
  let localProbe: string;
  const remoteProbe = `/var/www/.fileferry-ftp-it-${process.pid}-${Date.now()}.txt`;

  beforeAll(async () => {
    localProbe = path.join(os.tmpdir(), `fileferry-ftp-it-${process.pid}.txt`);
    fs.writeFileSync(localProbe, 'fileferry ftp integration probe\n');

    service = new FtpService();
    try {
      await service.connect(server, { password: PASS });
    } catch (err) {
      throw new Error(
        `Cannot reach the FTP test container at ${HOST}:${PORT} (${(err as Error).message}).\n` +
        `Start it with:\n` +
        `  docker run -d --name fileferry-ftp -p ${PORT}:21 -p 21100-21110:21100-21110 \\\n` +
        `    -e USERS="testuser|testpass|/var/www" -e ADDRESS=127.0.0.1 -e MIN_PORT=21100 -e MAX_PORT=21110 \\\n` +
        `    delfer/alpine-ftp-server`
      );
    }
  });

  afterAll(async () => {
    try { await service.deleteFile(remoteProbe); } catch { /* best effort cleanup */ }
    try { await service.disconnect(); } catch { /* ignore */ }
    try { fs.unlinkSync(localProbe); } catch { /* ignore */ }
  });

  it('uploadFile round-trips (temp + rename) and the file lands on the server', async () => {
    await service.uploadFile(localProbe, remoteProbe);
    const stats = await service.stat(remoteProbe);
    expect(stats).not.toBeNull();
    // A freshly uploaded file's mtime should be a real, recent Date — not NaN.
    expect(Number.isNaN(stats!.mtime.getTime())).toBe(false);
    expect(Math.abs(Date.now() - stats!.mtime.getTime())).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('listDirectory shows the uploaded file', async () => {
    const entries = await service.listDirectory('/var/www');
    expect(entries.some(entry => entry.name === path.posix.basename(remoteProbe))).toBe(true);
  });

  it('stat() returns null for a file that does not exist', async () => {
    const stats = await service.stat(`/var/www/.fileferry-does-not-exist-${Date.now()}.txt`);
    expect(stats).toBeNull();
  });

  it('deleteFile removes the file from the server', async () => {
    await service.deleteFile(remoteProbe);
    const stats = await service.stat(remoteProbe);
    expect(stats).toBeNull();
  });
});
