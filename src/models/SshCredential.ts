export type AuthMethod = 'password' | 'key' | 'agent';

export interface SshCredential {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string; // only when authMethod === 'key'
}

// SshCredentialWithSecret is used only internally when establishing a connection.
// It is NEVER persisted to disk — secrets come from the OS keychain at connection time.
export interface SshCredentialWithSecret extends SshCredential {
  password?: string;
  passphrase?: string;
}
