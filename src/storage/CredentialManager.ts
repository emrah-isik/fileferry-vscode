import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SshCredential, SshCredentialWithSecret } from '../models/SshCredential';

export class CredentialManager {
  private readonly filePath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.filePath = path.join(context.globalStorageUri.fsPath, 'credentials.json');
  }

  async getAll(): Promise<SshCredential[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as SshCredential[];
    } catch {
      return [];
    }
  }

  async save(
    credential: SshCredential,
    password?: string,
    passphrase?: string
  ): Promise<void> {
    const all = await this.getAll();
    const idx = all.findIndex(c => c.id === credential.id);
    if (idx >= 0) {
      all[idx] = credential;
    } else {
      all.push(credential);
    }
    await this.writeFile(all);

    if (password !== undefined) {
      await this.context.secrets.store(
        `fileferry.credential.${credential.id}.password`, password
      );
    }
    if (passphrase !== undefined) {
      await this.context.secrets.store(
        `fileferry.credential.${credential.id}.passphrase`, passphrase
      );
    }
  }

  async delete(id: string): Promise<void> {
    const all = await this.getAll();
    await this.writeFile(all.filter(c => c.id !== id));
    await this.context.secrets.delete(`fileferry.credential.${id}.password`);
    await this.context.secrets.delete(`fileferry.credential.${id}.passphrase`);
  }

  async getWithSecret(id: string): Promise<SshCredentialWithSecret> {
    const all = await this.getAll();
    const credential = all.find(c => c.id === id);
    if (!credential) {
      throw new Error(`Credential not found: ${id}`);
    }
    const password = await this.context.secrets.get(
      `fileferry.credential.${id}.password`
    );
    const passphrase = await this.context.secrets.get(
      `fileferry.credential.${id}.passphrase`
    );
    return { ...credential, password, passphrase };
  }

  private async writeFile(credentials: SshCredential[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(credentials, null, 2), 'utf-8');
  }
}
