import * as vscode from 'vscode';

// SecretManager is a thin wrapper around VSCode's SecretStorage API.
// SecretStorage stores values in the OS keychain (macOS Keychain,
// Windows Credential Manager, Linux libsecret) — never on disk as plaintext.

export class SecretManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(serverId: string, type: 'password' | 'passphrase'): string {
    return `fileferry.server.${serverId}.${type}`;
  }

  async storePassword(serverId: string, password: string): Promise<void> {
    await this.secrets.store(this.key(serverId, 'password'), password);
  }

  async getPassword(serverId: string): Promise<string | undefined> {
    return this.secrets.get(this.key(serverId, 'password'));
  }

  async storePassphrase(serverId: string, passphrase: string): Promise<void> {
    await this.secrets.store(this.key(serverId, 'passphrase'), passphrase);
  }

  async getPassphrase(serverId: string): Promise<string | undefined> {
    return this.secrets.get(this.key(serverId, 'passphrase'));
  }

  // Called when a server is deleted — cleans up all its secrets from the keychain.
  async clearServerSecrets(serverId: string): Promise<void> {
    await this.secrets.delete(this.key(serverId, 'password'));
    await this.secrets.delete(this.key(serverId, 'passphrase'));
  }
}
