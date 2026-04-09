import { UploadOrchestratorV2, UploadSummaryV2 } from '../../../services/UploadOrchestratorV2';
import type { ResolvedUploadItem } from '../../../path/PathResolver';
import type { CancellationToken } from 'vscode';

const mockSftp = {
  connect: jest.fn().mockResolvedValue(undefined),
  uploadFile: jest.fn().mockResolvedValue(undefined),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  chmod: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../../sftpService', () => ({
  SftpService: jest.fn().mockImplementation(() => mockSftp),
}));

const credential = { id: 'c1', host: 'h', port: 22, username: 'u', authMethod: 'password', password: 'p' } as any;
const server = { id: 's1', name: 'Prod', rootPath: '/var/www' } as any;

function item(name: string): ResolvedUploadItem {
  return { localPath: `/workspace/${name}`, remotePath: `/var/www/${name}` };
}

function makeCancellationToken(cancelled: boolean): CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: jest.fn(),
  };
}

describe('UploadOrchestratorV2 — cancellation', () => {
  let orchestrator: UploadOrchestratorV2;

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new UploadOrchestratorV2(mockSftp as any);
  });

  it('uploads all files when no token is provided', async () => {
    const items = [item('a.php'), item('b.php')];
    const result = await orchestrator.upload(items, credential, server);

    expect(mockSftp.uploadFile).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toHaveLength(2);
    expect(result.cancelled).toBeUndefined();
  });

  it('uploads all files when token is not cancelled', async () => {
    const token = makeCancellationToken(false);
    const items = [item('a.php'), item('b.php')];
    const result = await orchestrator.upload(items, credential, server, [], token);

    expect(mockSftp.uploadFile).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toHaveLength(2);
  });

  it('skips remaining uploads when token is cancelled before loop', async () => {
    const token = makeCancellationToken(true);
    const items = [item('a.php'), item('b.php')];
    const result = await orchestrator.upload(items, credential, server, [], token);

    expect(mockSftp.uploadFile).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual(items);
  });

  it('stops uploading mid-loop when cancellation is requested', async () => {
    let uploadCount = 0;
    const token: CancellationToken = {
      get isCancellationRequested() {
        // Cancel after the first upload completes
        return uploadCount >= 1;
      },
      onCancellationRequested: jest.fn(),
    };

    mockSftp.uploadFile.mockImplementation(async () => { uploadCount++; });

    const items = [item('a.php'), item('b.php'), item('c.php')];
    const result = await orchestrator.upload(items, credential, server, [], token);

    expect(mockSftp.uploadFile).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toHaveLength(1);
    expect(result.cancelled).toEqual([item('b.php'), item('c.php')]);
  });

  it('skips deletions when cancelled', async () => {
    const token = makeCancellationToken(true);
    const result = await orchestrator.upload([], credential, server, ['/var/www/old.php'], token);

    expect(mockSftp.deleteFile).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual([]);
  });

  it('still disconnects when cancelled', async () => {
    const token = makeCancellationToken(true);
    await orchestrator.upload([item('a.php')], credential, server, [], token);

    expect(mockSftp.disconnect).toHaveBeenCalled();
  });
});

describe('UploadOrchestratorV2 — permissions', () => {
  let orchestrator: UploadOrchestratorV2;

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new UploadOrchestratorV2(mockSftp as any);
  });

  it('calls chmod after each successful upload when filePermissions is set', async () => {
    const serverWithPerms = { ...server, filePermissions: 0o644 };
    const items = [item('a.php'), item('b.php')];
    await orchestrator.upload(items, credential, serverWithPerms);

    expect(mockSftp.chmod).toHaveBeenCalledWith('/var/www/a.php', 0o644);
    expect(mockSftp.chmod).toHaveBeenCalledWith('/var/www/b.php', 0o644);
  });

  it('does not call chmod when filePermissions is not set', async () => {
    const items = [item('a.php')];
    await orchestrator.upload(items, credential, server);

    expect(mockSftp.chmod).not.toHaveBeenCalled();
  });

  it('does not call chmod for a failed upload', async () => {
    mockSftp.uploadFile.mockRejectedValueOnce(new Error('disk full'));
    const serverWithPerms = { ...server, filePermissions: 0o644 };
    const items = [item('a.php')];
    const result = await orchestrator.upload(items, credential, serverWithPerms);

    expect(result.failed).toHaveLength(1);
    expect(mockSftp.chmod).not.toHaveBeenCalled();
  });

  it('chmod failure does not prevent other uploads or cause the item to appear in failed', async () => {
    mockSftp.chmod.mockRejectedValueOnce(new Error('chmod not supported'));
    const serverWithPerms = { ...server, filePermissions: 0o644 };
    const items = [item('a.php'), item('b.php')];
    const result = await orchestrator.upload(items, credential, serverWithPerms);

    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(mockSftp.chmod).toHaveBeenCalledTimes(2);
  });
});
