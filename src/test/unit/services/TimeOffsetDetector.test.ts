import * as fs from 'fs';
import * as os from 'os';
import { TimeOffsetDetector } from '../../../services/TimeOffsetDetector';

jest.mock('fs');
jest.mock('os');

const mockService = {
  uploadFile: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn(),
  deleteFile: jest.fn().mockResolvedValue(undefined),
};

describe('TimeOffsetDetector', () => {
  let detector: TimeOffsetDetector;
  let dateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    detector = new TimeOffsetDetector();
    (os.tmpdir as jest.Mock).mockReturnValue('/tmp');
    mockService.deleteFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    dateSpy?.mockRestore();
  });

  it('returns remoteMtime minus local midpoint', async () => {
    const localBefore = 1000;
    const localAfter = 1200;
    const remoteMtime = new Date(2100); // 2100ms epoch
    let callCount = 0;
    dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => callCount++ === 0 ? localBefore : localAfter);
    mockService.stat.mockResolvedValueOnce({ mtime: remoteMtime });

    const offset = await detector.detect(mockService as any);

    // localEstimate = (1000 + 1200) / 2 = 1100
    // offsetMs = 2100 - 1100 = 1000
    expect(offset).toBe(1000);
  });

  it('uploads probe to /tmp/.fileferry-time-probe on remote', async () => {
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    mockService.stat.mockResolvedValueOnce({ mtime: new Date(0) });

    await detector.detect(mockService as any);

    expect(mockService.uploadFile).toHaveBeenCalledWith(
      expect.any(String),
      '/tmp/.fileferry-time-probe'
    );
  });

  it('stats /tmp/.fileferry-time-probe after upload', async () => {
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    mockService.stat.mockResolvedValueOnce({ mtime: new Date(0) });

    await detector.detect(mockService as any);

    expect(mockService.stat).toHaveBeenCalledWith('/tmp/.fileferry-time-probe');
  });

  it('swallows deleteFile errors silently', async () => {
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    mockService.stat.mockResolvedValueOnce({ mtime: new Date(0) });
    mockService.deleteFile.mockRejectedValueOnce(new Error('Permission denied'));

    await expect(detector.detect(mockService as any)).resolves.toBeDefined();
  });

  it('writes a local temp file before uploading', async () => {
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    mockService.stat.mockResolvedValueOnce({ mtime: new Date(0) });

    await detector.detect(mockService as any);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('fileferry'),
      expect.any(String)
    );
  });
});
