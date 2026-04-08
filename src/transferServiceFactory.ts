import { TransferService } from './transferService';
import { SftpService } from './sftpService';
import { FtpService } from './ftpService';
import { ServerType } from './types';

export function createTransferService(type: ServerType): TransferService {
  switch (type) {
    case 'ftp':
    case 'ftps':
    case 'ftps-implicit':
      return new FtpService();
    case 'sftp':
    default:
      return new SftpService();
  }
}
