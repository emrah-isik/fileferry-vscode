import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { utils as ssh2Utils } from 'ssh2';

export type HostKeyStatus = 'trusted' | 'unknown' | 'changed';

interface HostKeyEntry {
  /** Key algorithm (`ssh-ed25519`, `ssh-rsa`, …); informational only — never part of the match. */
  type: string;
  /** Base64 of the raw host-key blob as ssh2 hands it to `hostVerifier`. */
  key: string;
  addedAt: string;
}

type KnownHosts = Record<string, HostKeyEntry>;

/** Type recorded when the blob cannot be parsed (and by every entry written before 0.14.1). */
export const UNKNOWN_KEY_TYPE = 'ssh-unknown';

/**
 * Trust-on-first-use store for SSH host keys (`globalStorage/known_hosts.json`).
 *
 * Matching is by key material only: the stored `type` is descriptive and
 * ignored by `check()`, so entries written by older versions (all typed
 * `ssh-unknown`) keep working. Store writes are serialised through an
 * in-process promise chain so concurrent `trust()` calls cannot lose an entry
 * to a load→write race.
 */
export class HostKeyManager {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'known_hosts.json');
  }

  async check(host: string, port: number, key: string): Promise<HostKeyStatus> {
    const hosts = await this.load();
    const entry = hosts[this.hostId(host, port)];

    if (!entry) {
      return 'unknown';
    }
    return entry.key === key ? 'trusted' : 'changed';
  }

  trust(host: string, port: number, key: string): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const hosts = await this.load();
      hosts[this.hostId(host, port)] = {
        type: this.keyType(key),
        key,
        addedAt: new Date().toISOString().slice(0, 10),
      };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(hosts, null, 2), 'utf-8');
    });
    // Keep the chain alive even if this write fails; the caller still sees the rejection.
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  getFingerprint(key: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(Buffer.from(key, 'base64'))
      .digest('base64');
    return `SHA256:${hash}`;
  }

  private keyType(key: string): string {
    const parsed = ssh2Utils.parseKey(Buffer.from(key, 'base64'));
    return parsed instanceof Error ? UNKNOWN_KEY_TYPE : parsed.type;
  }

  private hostId(host: string, port: number): string {
    return `[${host}]:${port}`;
  }

  private async load(): Promise<KnownHosts> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as KnownHosts;
    } catch {
      return {};
    }
  }
}
