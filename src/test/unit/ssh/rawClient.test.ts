import { getRawClient } from '../../../ssh/rawClient';

describe('getRawClient', () => {
  it('returns the ssh2 Client that ssh2-sftp-client keeps on `.client`', () => {
    const rawClient = { on: jest.fn(), exec: jest.fn() };
    const sftp = { client: rawClient } as unknown as import('ssh2-sftp-client');
    expect(getRawClient(sftp)).toBe(rawClient);
  });

  it('throws a clear error when the wrapper has no underlying client', () => {
    const sftp = {} as unknown as import('ssh2-sftp-client');
    expect(() => getRawClient(sftp)).toThrow(/underlying ssh2 client/i);
  });
});
