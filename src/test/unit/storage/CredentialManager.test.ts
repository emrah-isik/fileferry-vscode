import * as path from 'path';
import { CredentialManager } from '../../../storage/CredentialManager';
import { SshCredential } from '../../../models/SshCredential';

// Mock fs/promises so no real disk writes happen in tests
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';
const mockReadFile  = fs.readFile as jest.Mock;
const mockWriteFile = fs.writeFile as jest.Mock;

// Minimal mock of vscode ExtensionContext
const secretStore = new Map<string, string>();
const mockContext = {
  globalStorageUri: { fsPath: '/tmp/test-storage' },
  secrets: {
    store: jest.fn(async (key: string, val: string) => { secretStore.set(key, val); }),
    get:   jest.fn(async (key: string) => secretStore.get(key)),
    delete: jest.fn(async (key: string) => { secretStore.delete(key); }),
  }
} as any;

const credentialFixture: SshCredential = {
  id: 'cred-1',
  name: 'Production SSH',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
};

describe('CredentialManager', () => {
  let manager: CredentialManager;

  beforeEach(() => {
    jest.clearAllMocks();
    secretStore.clear();
    manager = new CredentialManager(mockContext);
  });

  it('returns empty array when credentials.json does not exist', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    const result = await manager.getAll();
    expect(result).toEqual([]);
  });

  it('saves a credential and retrieves it by id', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' }); // empty initially
    await manager.save(credentialFixture);
    const written = JSON.parse((mockWriteFile.mock.calls[0][1] as string));
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('cred-1');
  });

  it('updates an existing credential without duplicating it', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([credentialFixture]));
    const updated = { ...credentialFixture, host: 'updated.com' };
    await manager.save(updated);
    const written = JSON.parse((mockWriteFile.mock.calls[0][1] as string));
    expect(written).toHaveLength(1);
    expect(written[0].host).toBe('updated.com');
  });

  it('deletes a credential by id', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([credentialFixture]));
    await manager.delete('cred-1');
    const written = JSON.parse((mockWriteFile.mock.calls[0][1] as string));
    expect(written).toHaveLength(0);
  });

  it('stores password in SecretStorage, not in credentials.json', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    await manager.save(credentialFixture, 'mypassword');
    const written = JSON.parse((mockWriteFile.mock.calls[0][1] as string));
    // No password field in the JSON file
    expect(JSON.stringify(written)).not.toContain('mypassword');
    // But it IS in the secret store
    expect(mockContext.secrets.store).toHaveBeenCalledWith(
      'fileferry.credential.cred-1.password', 'mypassword'
    );
  });

  it('stores passphrase in SecretStorage, not in credentials.json', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    await manager.save(credentialFixture, undefined, 'mypassphrase');
    expect(mockContext.secrets.store).toHaveBeenCalledWith(
      'fileferry.credential.cred-1.passphrase', 'mypassphrase'
    );
  });

  it('getWithSecret returns credential combined with secret fields', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([credentialFixture]));
    secretStore.set('fileferry.credential.cred-1.password', 'secret123');
    const result = await manager.getWithSecret('cred-1');
    expect(result.host).toBe('example.com');
    expect(result.password).toBe('secret123');
  });

  it('getWithSecret throws if credentialId not found', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([]));
    await expect(manager.getWithSecret('ghost')).rejects.toThrow('Credential not found: ghost');
  });

  it('getAll returns all credentials without secret fields', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([credentialFixture]));
    const all = await manager.getAll();
    expect(all).toHaveLength(1);
    expect((all[0] as any).password).toBeUndefined();
  });

  it('delete cleans up secrets from keychain', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([credentialFixture]));
    await manager.delete('cred-1');
    expect(mockContext.secrets.delete).toHaveBeenCalledWith('fileferry.credential.cred-1.password');
    expect(mockContext.secrets.delete).toHaveBeenCalledWith('fileferry.credential.cred-1.passphrase');
  });
});
