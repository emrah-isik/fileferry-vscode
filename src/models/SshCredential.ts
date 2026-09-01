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
  // Ordered credential ids to hop through, first-hop → last-hop-before-target
  // (feature 18a-2a, Q2/Q3). A credential referenced here must itself have no
  // jumpHosts — chains are flat, validation rejects nesting from both sides.
  jumpHosts?: string[];
}

// SshCredentialWithSecret is used only internally when establishing a connection.
// It is NEVER persisted to disk — secrets come from the OS keychain at connection time.
export interface SshCredentialWithSecret extends SshCredential {
  password?: string;
  passphrase?: string;
}
