import {
  HookSecretManager,
  isValidHookSecretName,
} from '../../../storage/HookSecretManager';

// In-memory doubles for the two VS Code stores the manager sits on: secret
// values live in SecretStorage (OS keychain), the names index lives in
// workspaceState (names are not secret; values are).
const secretStore = new Map<string, string>();
const workspaceStateStore = new Map<string, unknown>();

const mockContext = {
  secrets: {
    store: jest.fn(async (key: string, value: string) => { secretStore.set(key, value); }),
    get: jest.fn(async (key: string) => secretStore.get(key)),
    delete: jest.fn(async (key: string) => { secretStore.delete(key); }),
  },
  workspaceState: {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      workspaceStateStore.has(key) ? workspaceStateStore.get(key) : defaultValue
    ),
    update: jest.fn(async (key: string, value: unknown) => {
      if (value === undefined) {
        workspaceStateStore.delete(key);
      } else {
        workspaceStateStore.set(key, value);
      }
    }),
  },
} as any;

const WORKSPACE_ROOT = '/home/user/projects/my-site';
const OTHER_WORKSPACE_ROOT = '/home/user/projects/unrelated-repo';

describe('HookSecretManager', () => {
  let manager: HookSecretManager;

  beforeEach(() => {
    jest.clearAllMocks();
    secretStore.clear();
    workspaceStateStore.clear();
    manager = new HookSecretManager(mockContext, WORKSPACE_ROOT);
  });

  describe('store / get round-trip', () => {
    it('stores a value and reads it back by name', async () => {
      await manager.store('API_TOKEN', 'tok-12345');
      expect(await manager.get('API_TOKEN')).toBe('tok-12345');
    });

    it('returns undefined for a name that was never stored', async () => {
      expect(await manager.get('NEVER_STORED')).toBeUndefined();
    });

    it('overwrites the value when storing an existing name again', async () => {
      await manager.store('API_TOKEN', 'old-value');
      await manager.store('API_TOKEN', 'new-value');
      expect(await manager.get('API_TOKEN')).toBe('new-value');
    });

    it('keeps the value out of workspaceState — only SecretStorage holds it', async () => {
      await manager.store('API_TOKEN', 'tok-12345');
      const workspaceStateDump = JSON.stringify([...workspaceStateStore.entries()]);
      expect(workspaceStateDump).not.toContain('tok-12345');
      expect([...secretStore.values()]).toContain('tok-12345');
    });
  });

  describe('per-project scoping', () => {
    it('namespaces the SecretStorage key with a scope derived from the workspace root', async () => {
      await manager.store('API_TOKEN', 'tok-12345');
      const storedKey = (mockContext.secrets.store as jest.Mock).mock.calls[0][0] as string;
      expect(storedKey).toMatch(/^fileferry\.hookSecret\.[0-9a-f]+\.API_TOKEN$/);
    });

    it('does not expose a secret stored under a different workspace root', async () => {
      await manager.store('API_TOKEN', 'tok-for-my-site');
      const otherManager = new HookSecretManager(mockContext, OTHER_WORKSPACE_ROOT);
      expect(await otherManager.get('API_TOKEN')).toBeUndefined();
      expect(otherManager.listNames()).toEqual([]);
    });

    it('derives the same scope for the same workspace root across instances', async () => {
      await manager.store('API_TOKEN', 'tok-12345');
      const secondInstance = new HookSecretManager(mockContext, WORKSPACE_ROOT);
      expect(await secondInstance.get('API_TOKEN')).toBe('tok-12345');
      expect(secondInstance.listNames()).toEqual(['API_TOKEN']);
    });
  });

  describe('names index', () => {
    it('starts empty', () => {
      expect(manager.listNames()).toEqual([]);
    });

    it('lists a stored name', async () => {
      await manager.store('API_TOKEN', 'tok-12345');
      expect(manager.listNames()).toEqual(['API_TOKEN']);
    });

    it('does not duplicate a name stored twice', async () => {
      await manager.store('API_TOKEN', 'old-value');
      await manager.store('API_TOKEN', 'new-value');
      expect(manager.listNames()).toEqual(['API_TOKEN']);
    });

    it('lists names sorted alphabetically regardless of insertion order', async () => {
      await manager.store('ZULU_TOKEN', 'z');
      await manager.store('ALPHA_TOKEN', 'a');
      expect(manager.listNames()).toEqual(['ALPHA_TOKEN', 'ZULU_TOKEN']);
    });

    it('reports has() from the index without touching SecretStorage', async () => {
      await manager.store('API_TOKEN', 'tok-12345');
      (mockContext.secrets.get as jest.Mock).mockClear();
      expect(manager.has('API_TOKEN')).toBe(true);
      expect(manager.has('NEVER_STORED')).toBe(false);
      expect(mockContext.secrets.get).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('removes the value from SecretStorage and the name from the index', async () => {
      await manager.store('API_TOKEN', 'tok-12345');
      await manager.delete('API_TOKEN');
      expect(await manager.get('API_TOKEN')).toBeUndefined();
      expect(manager.listNames()).toEqual([]);
      expect(secretStore.size).toBe(0);
    });

    it('is a no-op for a name that does not exist', async () => {
      await manager.store('API_TOKEN', 'tok-12345');
      await manager.delete('NEVER_STORED');
      expect(manager.listNames()).toEqual(['API_TOKEN']);
    });
  });

  describe('rename', () => {
    it('moves the value to the new name and updates the index', async () => {
      await manager.store('OLD_NAME', 'tok-12345');
      await manager.rename('OLD_NAME', 'NEW_NAME');
      expect(await manager.get('NEW_NAME')).toBe('tok-12345');
      expect(await manager.get('OLD_NAME')).toBeUndefined();
      expect(manager.listNames()).toEqual(['NEW_NAME']);
    });

    it('rejects renaming onto a name that already exists', async () => {
      await manager.store('FIRST', 'value-1');
      await manager.store('SECOND', 'value-2');
      await expect(manager.rename('FIRST', 'SECOND')).rejects.toThrow(/already exists/i);
      expect(await manager.get('SECOND')).toBe('value-2');
    });

    it('rejects renaming a name that does not exist', async () => {
      await expect(manager.rename('NEVER_STORED', 'NEW_NAME')).rejects.toThrow(/does not exist/i);
    });
  });

  describe('name validation', () => {
    // Names become environment variable names on local injection, so they must
    // be valid as such: letters, digits, underscores, not starting with a digit.
    it.each(['API_TOKEN', 'DB_PASS', '_PRIVATE', 'TOKEN2', 'lowercase_ok'])(
      'accepts %s', (name) => {
        expect(isValidHookSecretName(name)).toBe(true);
      }
    );

    it.each(['', 'MY-TOKEN', 'MY TOKEN', '2LEGIT', 'DOTTED.NAME', '${secret:X}', 'ÜMLAUT'])(
      'rejects %s', (name) => {
        expect(isValidHookSecretName(name)).toBe(false);
      }
    );

    it('store() throws on an invalid name and stores nothing', async () => {
      await expect(manager.store('BAD-NAME', 'value')).rejects.toThrow(/name/i);
      expect(secretStore.size).toBe(0);
      expect(manager.listNames()).toEqual([]);
    });

    it('rename() throws on an invalid target name and changes nothing', async () => {
      await manager.store('GOOD_NAME', 'value');
      await expect(manager.rename('GOOD_NAME', 'BAD NAME')).rejects.toThrow(/name/i);
      expect(await manager.get('GOOD_NAME')).toBe('value');
      expect(manager.listNames()).toEqual(['GOOD_NAME']);
    });
  });
});
