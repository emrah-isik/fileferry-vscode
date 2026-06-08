export type AuthMethod = 'password' | 'key' | 'agent' | 'keyboard-interactive';

export interface SshCredential {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string; // only when authMethod === 'key'
  agentSocketPath?: string; // only when authMethod === 'agent' — custom socket override
  useSshConfig?: boolean; // when true, `host` is an ~/.ssh/config Host alias resolved at connect time (SFTP only)
}

// SshCredentialWithSecret is used only internally when establishing a connection.
// It is NEVER persisted to disk — secrets come from the OS keychain at connection time.
export interface SshCredentialWithSecret extends SshCredential {
  password?: string;
  passphrase?: string;
}
