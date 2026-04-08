import { TransferService } from '../../transferService';
import { SftpService } from '../../sftpService';

describe('TransferService interface', () => {
  it('SftpService satisfies TransferService', () => {
    const service: TransferService = new SftpService();
    expect(service).toBeDefined();
    expect(typeof service.connect).toBe('function');
    expect(typeof service.uploadFile).toBe('function');
    expect(typeof service.get).toBe('function');
    expect(typeof service.listDirectory).toBe('function');
    expect(typeof service.listDirectoryDetailed).toBe('function');
    expect(typeof service.resolveRemotePath).toBe('function');
    expect(typeof service.statType).toBe('function');
    expect(typeof service.stat).toBe('function');
    expect(typeof service.deleteFile).toBe('function');
    expect(typeof service.deleteDirectory).toBe('function');
    expect(typeof service.disconnect).toBe('function');
  });
});
