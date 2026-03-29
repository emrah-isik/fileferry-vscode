import { SecretManager } from '../secretManager';

const mockGet = jest.fn();
const mockStore = jest.fn();
const mockDelete = jest.fn();

const mockSecrets = {
  get: mockGet,
  store: mockStore,
  delete: mockDelete,
  onDidChange: jest.fn(),
};

describe('SecretManager', () => {
  let manager: SecretManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new SecretManager(mockSecrets as any);
  });

  it('stores password under namespaced key', async () => {
    await manager.storePassword('prod', 'secret123');
    expect(mockStore).toHaveBeenCalledWith(
      'fileferry.server.prod.password',
      'secret123'
    );
  });

  it('retrieves stored password', async () => {
    mockGet.mockResolvedValue('secret123');
    const result = await manager.getPassword('prod');
    expect(result).toBe('secret123');
    expect(mockGet).toHaveBeenCalledWith('fileferry.server.prod.password');
  });

  it('returns undefined for missing password', async () => {
    mockGet.mockResolvedValue(undefined);
    const result = await manager.getPassword('nonexistent');
    expect(result).toBeUndefined();
  });

  it('stores passphrase under namespaced key', async () => {
    await manager.storePassphrase('staging', 'mypassphrase');
    expect(mockStore).toHaveBeenCalledWith(
      'fileferry.server.staging.passphrase',
      'mypassphrase'
    );
  });

  it('retrieves stored passphrase', async () => {
    mockGet.mockResolvedValue('mypassphrase');
    const result = await manager.getPassphrase('staging');
    expect(result).toBe('mypassphrase');
  });

  it('deletes both password and passphrase on server removal', async () => {
    await manager.clearServerSecrets('prod');
    expect(mockDelete).toHaveBeenCalledWith('fileferry.server.prod.password');
    expect(mockDelete).toHaveBeenCalledWith('fileferry.server.prod.passphrase');
  });
});
