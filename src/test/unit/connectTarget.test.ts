import { toConnectTarget } from '../../connectTarget';
import type { ConnectTarget } from '../../connectTarget';
import type { SshCredentialWithSecret } from '../../models/SshCredential';

// Regression guard for the FTPS type-drop bug (feature 35 pre-work): most
// connect paths used to hand the transport a bare credential, which has no
// `type`, so FtpService picked `secure: false` for ftps / ftps-implicit
// servers. The builder is the ONE place a connect payload is assembled.

const credential: SshCredentialWithSecret = {
  id: 'cred-1',
  name: 'Prod',
  host: 'files.example.com',
  port: 990,
  username: 'deploy',
  authMethod: 'password',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
  agentSocketPath: '/run/user/1000/agent.sock',
  useSshConfig: true,
  jumpHosts: ['cred-bastion'],
  password: 'secret',
  passphrase: 'phrase',
};

describe('toConnectTarget', () => {
  it('carries the SERVER type onto the payload — the field the credential lacks', () => {
    expect(toConnectTarget(credential, 'ftps').type).toBe('ftps');
    expect(toConnectTarget(credential, 'ftps-implicit').type).toBe('ftps-implicit');
    expect(toConnectTarget(credential, 'sftp').type).toBe('sftp');
  });

  it('copies every connection field a transport reads, plus the secrets, and nothing else', () => {
    expect(toConnectTarget(credential, 'ftps')).toEqual({
      type: 'ftps',
      host: 'files.example.com',
      port: 990,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: '/home/user/.ssh/id_ed25519',
      agentSocketPath: '/run/user/1000/agent.sock',
      useSshConfig: true,
      jumpHosts: ['cred-bastion'],
      password: 'secret',
      passphrase: 'phrase',
    });
  });

  it('leaves credential identity (id, name) behind — the payload is a dial target, not a stored record', () => {
    const target = toConnectTarget(credential, 'sftp');
    expect(target).not.toHaveProperty('id');
    expect(target).not.toHaveProperty('name');
  });

  it('is a copy: mutating the target never touches the credential', () => {
    const target = toConnectTarget(credential, 'sftp');
    target.host = 'other';
    target.jumpHosts?.push('cred-x');
    expect(credential.host).toBe('files.example.com');
    expect(credential.jumpHosts).toEqual(['cred-bastion']);
  });

  it('a bare credential is NOT a ConnectTarget (compile-time guard against the type drop)', () => {
    // @ts-expect-error — SshCredentialWithSecret has no `type`; the guard exists so no
    // call site can hand a credential straight to TransferService.connect again.
    const target: ConnectTarget = credential;
    expect(target).toBeDefined();
  });
});
