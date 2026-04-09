import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TransferService } from '../transferService';

const REMOTE_PROBE_PATH = '/tmp/.fileferry-time-probe';

export class TimeOffsetDetector {
  async detect(service: TransferService): Promise<number> {
    const localTempPath = path.join(os.tmpdir(), '.fileferry-time-probe');
    fs.writeFileSync(localTempPath, 'fileferry-time-probe');

    const localBefore = Date.now();
    await service.uploadFile(localTempPath, REMOTE_PROBE_PATH);
    const remoteStat = await service.stat(REMOTE_PROBE_PATH);
    const localAfter = Date.now();

    try {
      await service.deleteFile(REMOTE_PROBE_PATH);
    } catch {
      // Swallow silently — creds may lack delete permission; tiny file in /tmp is harmless
    }

    try {
      fs.unlinkSync(localTempPath);
    } catch {
      // Swallow silently
    }

    const localEstimate = (localBefore + localAfter) / 2;
    const offsetMs = (remoteStat?.mtime.getTime() ?? localEstimate) - localEstimate;
    return offsetMs;
  }
}
