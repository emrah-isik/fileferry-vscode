import { HostKeyManager } from '../../../ssh/HostKeyManager';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

jest.mock('fs/promises');

const STORAGE_DIR = '/fake/global-storage';

// A real ssh-ed25519 public key blob (throw-away key generated for this test)
const ED25519_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIK16L2vFd9b/S0u0S9HvIg+zpggkMbEMdHMoj7GqnExo';

describe('HostKeyManager', () => {
  let manager: HostKeyManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new HostKeyManager(STORAGE_DIR);
    // Default: no known_hosts file exists yet
    (fs.readFile as jest.Mock).mockRejectedValue(new Error('ENOENT'));
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
  });

  describe('check', () => {
    it('returns "unknown" for a host not in known_hosts', async () => {
      const result = await manager.check('example.com', 22, 'AAAA1234');
      expect(result).toBe('unknown');
    });

    it('returns "trusted" when host key matches known_hosts', async () => {
      const knownHosts = {
        '[example.com]:22': { type: 'ssh-ed25519', key: 'AAAA1234', addedAt: '2026-04-04' }
      };
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(knownHosts));
      const result = await manager.check('example.com', 22, 'AAAA1234');
      expect(result).toBe('trusted');
    });

    it('returns "changed" when host key differs from known_hosts', async () => {
      const knownHosts = {
        '[example.com]:22': { type: 'ssh-ed25519', key: 'AAAA1234', addedAt: '2026-04-04' }
      };
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(knownHosts));
      const result = await manager.check('example.com', 22, 'BBBB5678');
      expect(result).toBe('changed');
    });

    it('matches on the key alone — a stale stored type does not make it "changed"', async () => {
      // Entries written before 0.14.1 all carry type 'ssh-unknown'
      const knownHosts = {
        '[example.com]:22': { type: 'ssh-unknown', key: 'AAAA1234', addedAt: '2026-04-04' }
      };
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(knownHosts));
      const result = await manager.check('example.com', 22, 'AAAA1234');
      expect(result).toBe('trusted');
    });

    it('uses [host]:port format as key', async () => {
      const knownHosts = {
        '[myserver.io]:2222': { type: 'ssh-ed25519', key: 'KEY123', addedAt: '2026-04-04' }
      };
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(knownHosts));
      const result = await manager.check('myserver.io', 2222, 'KEY123');
      expect(result).toBe('trusted');
    });
  });

  describe('trust', () => {
    it('saves a new host key to known_hosts with the real key type', async () => {
      await manager.trust('example.com', 22, ED25519_KEY);
      expect(fs.mkdir).toHaveBeenCalledWith(path.normalize(STORAGE_DIR), { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join(STORAGE_DIR, 'known_hosts.json'),
        expect.any(String),
        'utf-8'
      );
      const written = JSON.parse((fs.writeFile as jest.Mock).mock.calls[0][1]);
      expect(written['[example.com]:22']).toEqual(expect.objectContaining({
        type: 'ssh-ed25519',
        key: ED25519_KEY,
      }));
      expect(written['[example.com]:22'].addedAt).toBeDefined();
    });

    it('updates an existing host key entry', async () => {
      const knownHosts = {
        '[example.com]:22': { type: 'ssh-ed25519', key: 'OLD_KEY', addedAt: '2026-01-01' }
      };
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(knownHosts));
      await manager.trust('example.com', 22, ED25519_KEY);
      const written = JSON.parse((fs.writeFile as jest.Mock).mock.calls[0][1]);
      expect(written['[example.com]:22'].key).toBe(ED25519_KEY);
      expect(written['[example.com]:22'].type).toBe('ssh-ed25519');
    });

    it('stores type "ssh-unknown" when the key blob cannot be parsed', async () => {
      await manager.trust('example.com', 22, 'AAAA1234');
      const written = JSON.parse((fs.writeFile as jest.Mock).mock.calls[0][1]);
      expect(written['[example.com]:22'].type).toBe('ssh-unknown');
    });

    it('serialises concurrent trust() calls so neither write is lost', async () => {
      // Make the fake file system stateful: each write becomes the next read
      let stored: string | null = null;
      (fs.readFile as jest.Mock).mockImplementation(async () => {
        if (stored === null) { throw new Error('ENOENT'); }
        return stored;
      });
      (fs.writeFile as jest.Mock).mockImplementation(async (_path: string, data: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        stored = data;
      });

      await Promise.all([
        manager.trust('one.example', 22, 'KEY_ONE'),
        manager.trust('two.example', 22, 'KEY_TWO'),
      ]);

      const written = JSON.parse(stored!);
      expect(written['[one.example]:22'].key).toBe('KEY_ONE');
      expect(written['[two.example]:22'].key).toBe('KEY_TWO');
    });

    it('preserves other host entries when adding a new one', async () => {
      const knownHosts = {
        '[other.com]:22': { type: 'ssh-ed25519', key: 'OTHER', addedAt: '2026-01-01' }
      };
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(knownHosts));
      await manager.trust('example.com', 22, 'NEW');
      const written = JSON.parse((fs.writeFile as jest.Mock).mock.calls[0][1]);
      expect(written['[other.com]:22'].key).toBe('OTHER');
      expect(written['[example.com]:22'].key).toBe('NEW');
    });
  });

  describe('getFingerprint', () => {
    it('returns SHA-256 fingerprint of the key', () => {
      const key = 'AAAA1234';
      const expected = crypto
        .createHash('sha256')
        .update(Buffer.from(key, 'base64'))
        .digest('base64');
      const result = manager.getFingerprint(key);
      expect(result).toBe(`SHA256:${expected}`);
    });
  });
});
