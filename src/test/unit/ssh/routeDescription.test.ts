import { describeRoute } from '../../../ssh/routeDescription';
import { SshCredential } from '../../../models/SshCredential';

const bastion: SshCredential = {
  id: 'cred-bastion', name: 'Bastion', host: 'bastion.example.com', port: 2222, username: 'jump', authMethod: 'password',
};
const chained: SshCredential = {
  id: 'cred-chained', name: 'Via Bastion', host: 'target.internal', port: 22, username: 'deploy',
  authMethod: 'password', jumpHosts: ['cred-bastion'],
};
const direct: SshCredential = {
  id: 'cred-direct', name: 'Direct', host: 'direct.example.com', port: 22, username: 'www', authMethod: 'key', privateKeyPath: '~/.ssh/id_ed25519',
};
const aliased: SshCredential = {
  id: 'cred-alias', name: 'Prod alias', host: 'prod', port: 22, username: '', authMethod: 'key', useSshConfig: true,
};

const CONFIG = `
Host prod
    HostName 10.0.0.5
    User deploy
    ProxyJump bastion
Host bastion
    HostName bastion.example.com
    Port 2222
    User jump
Host loop
    ProxyJump loop
`;
const deps = { localUser: 'localdev', readFile: () => CONFIG };

describe('describeRoute', () => {
  it('lists local, every explicit hop in order, then the target', () => {
    expect(describeRoute(chained, [bastion, chained])).toBe('local → jump@bastion.example.com:2222 → deploy@target.internal:22');
  });

  it('is just local → target for a direct credential', () => {
    expect(describeRoute(direct, [direct])).toBe('local → www@direct.example.com:22');
  });

  it('marks a hop whose credential was deleted', () => {
    expect(describeRoute({ ...chained, jumpHosts: ['cred-gone', 'cred-bastion'] }, [bastion])).toBe(
      'local → (missing jump host) → jump@bastion.example.com:2222 → deploy@target.internal:22'
    );
  });

  it('shows the ProxyJump chain and the resolved target for an ~/.ssh/config alias (18b)', () => {
    expect(describeRoute(aliased, [aliased], deps)).toBe('local → jump@bastion.example.com:2222 → deploy@10.0.0.5:22');
  });

  it('prefers explicit jump hosts over ProxyJump for an alias (Q5-1)', () => {
    expect(describeRoute({ ...aliased, jumpHosts: ['cred-bastion'] }, [bastion], deps)).toBe(
      'local → jump@bastion.example.com:2222 → deploy@10.0.0.5:22'
    );
  });

  it('names a ProxyJump chain that cannot be followed', () => {
    expect(describeRoute({ ...aliased, host: 'loop' }, [], deps)).toBe(
      'local → (ProxyJump loop in ~/.ssh/config: loop → loop) → @loop:22'
    );
  });
});
