import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpService } from '../../sftpService';
import { ServerConfig } from '../../types';

/**
 * Real-server contract test for SftpService.stat().
 *
 * This is the layer the unit tests structurally cannot cover: the unit test mocks
 * ssh2-sftp-client's return shape, so it only proves the code matches our *assumption*
 * about the library. This test runs against an actual SFTP server, so it proves the
 * assumption itself — it is the test that would have caught the `stats.mtime` (NaN) bug.
 *
 * Opt-in only (excluded from `npm test`). Run with: npm run test:integration
 * Requires the SFTP test container — start it with:
 *   docker build -t fileferry-ssh dev/ssh-test
 *   docker run -d --rm -p 2222:22 --name fileferry-ssh fileferry-ssh
 * Connection details can be overridden via FILEFERRY_IT_HOST/PORT/USER/PASS.
 */

const HOST = process.env.FILEFERRY_IT_HOST ?? '127.0.0.1';
const PORT = Number(process.env.FILEFERRY_IT_PORT ?? '2222');
const USER = process.env.FILEFERRY_IT_USER ?? 'testuser';
const PASS = process.env.FILEFERRY_IT_PASS ?? 'testpass';

const server: ServerConfig = {
  id: 'integration',
  name: 'Integration',
  type: 'sftp',
  host: HOST,
  port: PORT,
  username: USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: []
};

describe('SftpService integration (real SFTP server)', () => {
  let service: SftpService;
  let localProbe: string;
  const remoteProbe = `/tmp/.fileferry-it-${process.pid}-${Date.now()}.txt`;

  beforeAll(async () => {
    localProbe = path.join(os.tmpdir(), `fileferry-it-${process.pid}.txt`);
    fs.writeFileSync(localProbe, 'fileferry integration probe\n');

    service = new SftpService();
    try {
      await service.connect(server, { password: PASS }, { hostVerifier: () => true });
    } catch (err) {
      throw new Error(
        `Cannot reach the SFTP test container at ${HOST}:${PORT} (${(err as Error).message}).\n` +
        `Start it with:\n` +
        `  docker build -t fileferry-ssh dev/ssh-test\n` +
        `  docker run -d --rm -p ${PORT}:22 --name fileferry-ssh fileferry-ssh`
      );
    }
  });

  afterAll(async () => {
    try { await service.deleteFile(remoteProbe); } catch { /* best effort cleanup */ }
    try { await service.disconnect(); } catch { /* ignore */ }
    try { fs.unlinkSync(localProbe); } catch { /* ignore */ }
  });

  it('stat() returns a real, sane mtime for a freshly uploaded file', async () => {
    await service.uploadFile(localProbe, remoteProbe);

    const result = await service.stat(remoteProbe);

    expect(result).not.toBeNull();
    const mtimeMs = result!.mtime.getTime();

    // The original bug read a non-existent `mtime` field → new Date(NaN). This is the
    // assertion that fails against that bug but passes the mocked unit test.
    expect(Number.isNaN(mtimeMs)).toBe(false);

    // A units error (e.g. double-scaling seconds→ms) would land the date far in the
    // future. The file was just written, so its remote mtime must be near "now".
    expect(Math.abs(mtimeMs - Date.now())).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('stat() returns null for a non-existent remote file', async () => {
    const result = await service.stat(`/tmp/.fileferry-it-missing-${process.pid}.txt`);
    expect(result).toBeNull();
  });
});
