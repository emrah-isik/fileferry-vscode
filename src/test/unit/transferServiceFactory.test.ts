import { createTransferService } from '../../transferServiceFactory';
import { SftpService } from '../../sftpService';
import { FtpService } from '../../ftpService';

describe('createTransferService', () => {
  it('returns SftpService for sftp type', () => {
    const service = createTransferService('sftp');
    expect(service).toBeInstanceOf(SftpService);
  });

  it('returns FtpService for ftp type', () => {
    const service = createTransferService('ftp');
    expect(service).toBeInstanceOf(FtpService);
  });

  it('returns FtpService for ftps type', () => {
    const service = createTransferService('ftps');
    expect(service).toBeInstanceOf(FtpService);
  });

  it('returns FtpService for ftps-implicit type', () => {
    const service = createTransferService('ftps-implicit');
    expect(service).toBeInstanceOf(FtpService);
  });

  it('defaults to SftpService for unknown type', () => {
    const service = createTransferService(undefined as any);
    expect(service).toBeInstanceOf(SftpService);
  });
});
