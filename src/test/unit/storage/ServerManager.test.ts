import { ServerManager } from '../../../storage/ServerManager';
import { DeploymentServer } from '../../../models/DeploymentServer';
import { CredentialManager } from '../../../storage/CredentialManager';

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';
const mockReadFile  = fs.readFile as jest.Mock;
const mockWriteFile = fs.writeFile as jest.Mock;

const mockContext = {
  globalStorageUri: { fsPath: '/tmp/test-storage' },
  secrets: {
    store: jest.fn(), get: jest.fn(), delete: jest.fn()
  }
} as any;

// Mock CredentialManager to control credential existence
const mockCredentialManager = {
  getAll: jest.fn(),
} as unknown as CredentialManager;

const serverFixture: DeploymentServer = {
  id: 'srv-1',
  name: 'Production',
  type: 'sftp',
  credentialId: 'cred-1',
  rootPath: '/var/www',
};

describe('ServerManager', () => {
  let manager: ServerManager;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([{ id: 'cred-1' }]);
    manager = new ServerManager(mockContext, mockCredentialManager);
  });

  it('returns empty array when servers.json does not exist', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    expect(await manager.getAll()).toEqual([]);
  });

  it('saves a server and retrieves it', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    await manager.save(serverFixture);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].name).toBe('Production');
  });

  it('updates an existing server in-place without duplicating', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([serverFixture]));
    await manager.save({ ...serverFixture, rootPath: '/var/www/v2' });
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].rootPath).toBe('/var/www/v2');
  });

  it('deletes a server by id', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([serverFixture]));
    await manager.delete('srv-1');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written).toHaveLength(0);
  });

  it('throws if referenced credentialId does not exist', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    (mockCredentialManager.getAll as jest.Mock).mockResolvedValue([]); // no credentials
    await expect(manager.save(serverFixture))
      .rejects.toThrow('Credential "cred-1" not found');
  });

  it('getAll returns all servers', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([serverFixture]));
    const all = await manager.getAll();
    expect(all).toHaveLength(1);
  });

  it('getServer returns undefined for unknown id', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([serverFixture]));
    expect(await manager.getServer('unknown')).toBeUndefined();
  });

  it('getServer returns the correct server for known id', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([serverFixture]));
    const server = await manager.getServer('srv-1');
    expect(server?.name).toBe('Production');
  });
});
