import type { ServerConfig, ServerType } from './types';
import type { SshCredentialWithSecret } from './models/SshCredential';

/**
 * What a transport dials: the credential's connection fields plus the
 * SERVER's protocol `type`. The two live in different records (a credential
 * is reusable across servers; the protocol belongs to the server), and a
 * bare `SshCredentialWithSecret` has no `type` — which is exactly how
 * `ftps` / `ftps-implicit` servers used to reach `FtpService.connect()`
 * as `secure: false` (feature 35 pre-work). `TransferService.connect()`
 * requires this shape, so a credential no longer compiles as a payload.
 */
export type ConnectTarget = Pick<
  ServerConfig,
  | 'type'
  | 'host'
  | 'port'
  | 'username'
  | 'authMethod'
  | 'privateKeyPath'
  | 'agentSocketPath'
  | 'useSshConfig'
  | 'jumpHosts'
  | 'algorithms'
>;

// Like SshCredentialWithSecret: built at connect time, never persisted.
export interface ConnectTargetWithSecret extends ConnectTarget {
  password?: string;
  passphrase?: string;
}

/**
 * The one place a connect payload is assembled. Every call site that fetches
 * a credential for a server goes through here so the next connection field
 * cannot be dropped the way `type` was.
 */
export function toConnectTarget(
  credential: SshCredentialWithSecret,
  type: ServerType
): ConnectTargetWithSecret {
  return {
    type,
    host: credential.host,
    port: credential.port,
    username: credential.username,
    authMethod: credential.authMethod,
    privateKeyPath: credential.privateKeyPath,
    agentSocketPath: credential.agentSocketPath,
    useSshConfig: credential.useSshConfig,
    jumpHosts: credential.jumpHosts ? [...credential.jumpHosts] : undefined,
    password: credential.password,
    passphrase: credential.passphrase,
  };
}
