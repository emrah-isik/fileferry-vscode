import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpService } from '../../sftpService';
import { FtpService } from '../../ftpService';
import { ServerConfig } from '../../types';

/**
 * Real-server contract tests for TransferService.rename (feature 33b, ruling C3).
 *
 * The rename command trusts rename() for the actual move and pre-checks
 * collisions itself with exists() — it never relies on server overwrite
 * semantics. The unit tests mock the clients, so they prove the calling
 * logic — not that the primitives behave. These tests pin the assumptions
 * against real servers, on BOTH transports:
 *
 *   1. Same-directory file rename — the basic op behind the panel command
 *   2. Cross-directory file rename — 33d move rides the same primitive
 *      (SFTP posixRename/rename, FTP RNFR/RNTO with absolute paths)
 *   3. Directory rename — folders go through the identical call
 *   4. Rename-onto-existing — documents what each server actually does,
 *      which is exactly why the command layer does its own exists()
 *      pre-check + delete-then-rename instead of trusting this
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
  id: 'integration-33b-sftp',
  name: 'Integration 33b SFTP',
  type: 'sftp',
  host: SFTP_HOST,
  port: SFTP_PORT,
  username: SFTP_USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

const ftpServer: ServerConfig = {
  id: 'integration-33b-ftp',
  name: 'Integration 33b FTP',
  type: 'ftp',
  host: FTP_HOST,
  port: FTP_PORT,
  username: FTP_USER,
  authMethod: 'password',
  mappings: [{ localPath: '/', remotePath: '/' }],
  excludedPaths: [],
};

describe('rename contract — SFTP', () => {
  let service: SftpService;
  let localSource: string;
  let localOther: string;
  const remoteBase = `/tmp/.fileferry-33b-it-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    localSource = path.join(os.tmpdir(), `fileferry-33b-it-source-${process.pid}.txt`);
    localOther = path.join(os.tmpdir(), `fileferry-33b-it-other-${process.pid}.txt`);
    fs.writeFileSync(localSource, 'source content');
    fs.writeFileSync(localOther, 'other content');

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
    try { fs.unlinkSync(localSource); } catch { /* ignore */ }
    try { fs.unlinkSync(localOther); } catch { /* ignore */ }
  });

  it('renames a file within the same directory', async () => {
    const oldPath = `${remoteBase}/same-dir-old.txt`;
    const newPath = `${remoteBase}/same-dir-new.txt`;
    await service.uploadFile(localSource, oldPath);

    await service.rename(oldPath, newPath);

    await expect(service.exists(oldPath)).resolves.toBe(false);
    await expect(service.exists(newPath)).resolves.toBe(true);
    await expect(service.get(newPath)).resolves.toEqual(Buffer.from('source content'));
  });

  it('renames a file across directories', async () => {
    const sourceDirectory = `${remoteBase}/from-dir`;
    const targetDirectory = `${remoteBase}/to-dir`;
    await service.mkdir(sourceDirectory);
    await service.mkdir(targetDirectory);
    const oldPath = `${sourceDirectory}/moved.txt`;
    const newPath = `${targetDirectory}/moved.txt`;
    await service.uploadFile(localSource, oldPath);

    await service.rename(oldPath, newPath);

    await expect(service.exists(oldPath)).resolves.toBe(false);
    await expect(service.exists(newPath)).resolves.toBe(true);
  });

  it('renames a directory, and its contents travel with it', async () => {
    const oldDirectory = `${remoteBase}/dir-old`;
    const newDirectory = `${remoteBase}/dir-new`;
    await service.mkdir(oldDirectory);
    await service.uploadFile(localSource, `${oldDirectory}/inside.txt`);

    await service.rename(oldDirectory, newDirectory);

    await expect(service.exists(oldDirectory)).resolves.toBe(false);
    await expect(service.statType(newDirectory)).resolves.toBe('d');
    await expect(service.exists(`${newDirectory}/inside.txt`)).resolves.toBe(true);
  });

  it('rename onto an existing file overwrites it (posixRename atomic-overwrite semantics)', async () => {
    const oldPath = `${remoteBase}/overwrite-source.txt`;
    const targetPath = `${remoteBase}/overwrite-target.txt`;
    await service.uploadFile(localSource, oldPath);
    await service.uploadFile(localOther, targetPath);

    await service.rename(oldPath, targetPath);

    await expect(service.exists(oldPath)).resolves.toBe(false);
    await expect(service.get(targetPath)).resolves.toEqual(Buffer.from('source content'));
  });
});

describe('rename contract — FTP (RNFR/RNTO)', () => {
  let service: FtpService;
  let localSource: string;
  let localOther: string;
  const remoteBase = `/var/www/.fileferry-33b-ftp-it-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    localSource = path.join(os.tmpdir(), `fileferry-33b-ftp-it-source-${process.pid}.txt`);
    localOther = path.join(os.tmpdir(), `fileferry-33b-ftp-it-other-${process.pid}.txt`);
    fs.writeFileSync(localSource, 'source content');
    fs.writeFileSync(localOther, 'other content');

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
    try { fs.unlinkSync(localSource); } catch { /* ignore */ }
    try { fs.unlinkSync(localOther); } catch { /* ignore */ }
  });

  it('renames a file within the same directory', async () => {
    const oldPath = `${remoteBase}/same-dir-old.txt`;
    const newPath = `${remoteBase}/same-dir-new.txt`;
    await service.uploadFile(localSource, oldPath);

    await service.rename(oldPath, newPath);

    await expect(service.exists(oldPath)).resolves.toBe(false);
    await expect(service.exists(newPath)).resolves.toBe(true);
    await expect(service.get(newPath)).resolves.toEqual(Buffer.from('source content'));
  });

  it('renames a file across directories with absolute paths, even after the cwd drifted', async () => {
    const sourceDirectory = `${remoteBase}/from-dir`;
    const targetDirectory = `${remoteBase}/to-dir`;
    await service.mkdir(sourceDirectory);
    await service.mkdir(targetDirectory);
    const oldPath = `${sourceDirectory}/moved.txt`;
    const newPath = `${targetDirectory}/moved.txt`;
    await service.uploadFile(localSource, oldPath);

    // mkdir (ensureDir) has drifted the client's working directory by now —
    // the absolute-paths-both-sides rule is exactly what this pins.
    await service.rename(oldPath, newPath);

    await expect(service.exists(oldPath)).resolves.toBe(false);
    await expect(service.exists(newPath)).resolves.toBe(true);
  });

  it('renames a directory, and its contents travel with it', async () => {
    const oldDirectory = `${remoteBase}/dir-old`;
    const newDirectory = `${remoteBase}/dir-new`;
    await service.mkdir(oldDirectory);
    await service.uploadFile(localSource, `${oldDirectory}/inside.txt`);

    await service.rename(oldDirectory, newDirectory);

    await expect(service.exists(oldDirectory)).resolves.toBe(false);
    await expect(service.statType(newDirectory)).resolves.toBe('d');
    await expect(service.exists(`${newDirectory}/inside.txt`)).resolves.toBe(true);
  });

  it('rename onto an existing file overwrites it (RNTO overwrite semantics on this server)', async () => {
    const oldPath = `${remoteBase}/overwrite-source.txt`;
    const targetPath = `${remoteBase}/overwrite-target.txt`;
    await service.uploadFile(localSource, oldPath);
    await service.uploadFile(localOther, targetPath);

    await service.rename(oldPath, targetPath);

    await expect(service.exists(oldPath)).resolves.toBe(false);
    await expect(service.get(targetPath)).resolves.toEqual(Buffer.from('source content'));
  });
});
