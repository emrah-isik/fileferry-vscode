import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export type HostKeyStatus = 'trusted' | 'unknown' | 'changed';

interface HostKeyEntry {
  type: string;
  key: string;
  addedAt: string;
}

type KnownHosts = Record<string, HostKeyEntry>;

export class HostKeyManager {
  private readonly filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'known_hosts.json');
  }

  async check(host: string, port: number, keyType: string, key: string): Promise<HostKeyStatus> {
    const hosts = await this.load();
    const id = this.hostId(host, port);
    const entry = hosts[id];

    if (!entry) {
      return 'unknown';
    }
    if (entry.type === keyType && entry.key === key) {
      return 'trusted';
    }
    return 'changed';
  }

  async trust(host: string, port: number, keyType: string, key: string): Promise<void> {
    const hosts = await this.load();
    const id = this.hostId(host, port);
    hosts[id] = { type: keyType, key, addedAt: new Date().toISOString().slice(0, 10) };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(hosts, null, 2), 'utf-8');
  }

  getFingerprint(key: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(Buffer.from(key, 'base64'))
      .digest('base64');
    return `SHA256:${hash}`;
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
