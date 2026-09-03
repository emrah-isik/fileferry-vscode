import * as path from 'path';
import {
  reportRouteNotices,
  resetRouteNoticesForTests,
  resolveRoute,
} from '../../../ssh/routeResolution';
import { SshConfigChainError } from '../../../ssh/SshConfigResolver';
import { SshCredential } from '../../../models/SshCredential';

const CONFIG = `
Host prod
    HostName 10.0.0.5
    User deploy
    ProxyJump bastion

Host bastion
    HostName bastion.example.com
    Port 2222
    User jump
    IdentityFile ~/.ssh/bastion_ed25519

Host direct
    HostName 10.0.0.6

Host cmd
    HostName 10.0.0.7
    ProxyCommand ssh -W %h:%p bastion

Host cmd-hop
    HostName 10.0.0.8
    ProxyJump bastion-cmd
Host bastion-cmd
    HostName bc.example.com
    ProxyCommand nc bc 22

Host loop
    ProxyJump loop
`;

const deps = { homeDir: '/home/dev', localUser: 'localdev', readFile: () => CONFIG };

function credential(overrides: Partial<SshCredential>): SshCredential {
  return {
    id: 'cred-target', name: 'Target', host: 'prod', port: 22, username: '',
    authMethod: 'password', ...overrides,
  };
}

describe('resolveRoute', () => {
  it('leaves a credential without useSshConfig alone and uses its explicit jump hosts', () => {
    const input = credential({ host: 'real.example.com', username: 'deploy', jumpHosts: ['cred-hop'] });
    const route = resolveRoute(input, deps);
    expect(route.target).toBe(input);
    expect(route.hops).toEqual(['cred-hop']);
    expect(route.notes).toEqual([]);
    expect(route.proxyCommandHosts).toEqual([]);
  });

  it('applies ~/.ssh/config to the target and derives the hops from ProxyJump', () => {
    const route = resolveRoute(credential({ useSshConfig: true }), deps);
    expect(route.target).toMatchObject({ host: '10.0.0.5', port: 22, username: 'deploy' });
    expect(route.hops).toEqual([{
      alias: 'bastion', host: 'bastion.example.com', port: 2222, user: 'jump',
      identityFile: path.join('/home/dev', '.ssh/bastion_ed25519'),
    }]);
    expect(route.notes).toEqual([]);
  });

  it('explicit jump hosts win over ProxyJump, with one note (Q5-1)', () => {
    const route = resolveRoute(credential({ useSshConfig: true, jumpHosts: ['cred-hop'] }), deps);
    expect(route.hops).toEqual(['cred-hop']);
    expect(route.notes).toEqual([
      'ProxyJump for "prod" in ~/.ssh/config ignored — the credential\'s own jump hosts take precedence',
    ]);
  });

  it('adds no note when explicit jump hosts are set but the alias has no ProxyJump', () => {
    const route = resolveRoute(credential({ host: 'direct', useSshConfig: true, jumpHosts: ['cred-hop'] }), deps);
    expect(route.hops).toEqual(['cred-hop']);
    expect(route.notes).toEqual([]);
  });

  it('reports a ProxyCommand on the target and connects directly (Q5-2)', () => {
    const route = resolveRoute(credential({ host: 'cmd', useSshConfig: true }), deps);
    expect(route.hops).toEqual([]);
    expect(route.target.host).toBe('10.0.0.7');
    expect(route.proxyCommandHosts).toEqual(['cmd']);
  });

  it('reports a ProxyCommand on a hop while keeping the hop in the route', () => {
    const route = resolveRoute(credential({ host: 'cmd-hop', useSshConfig: true }), deps);
    expect(route.hops).toHaveLength(1);
    expect(route.proxyCommandHosts).toEqual(['bastion-cmd']);
  });

  it('propagates a chain error so the connect fails with the resolver\'s message', () => {
    expect(() => resolveRoute(credential({ host: 'loop', useSshConfig: true }), deps)).toThrow(SshConfigChainError);
  });
});

describe('reportRouteNotices', () => {
  let logged: string[];
  let warned: string[];
  const providers = {
    log: (line: string) => logged.push(line),
    warn: (message: string) => warned.push(message),
  };

  beforeEach(() => {
    logged = [];
    warned = [];
    resetRouteNoticesForTests();
  });

  it('logs the ignored-ProxyJump note once per alias per session', () => {
    const route = resolveRoute(credential({ useSshConfig: true, jumpHosts: ['cred-hop'] }), deps);
    reportRouteNotices(route, providers);
    reportRouteNotices(route, providers);
    expect(logged).toEqual([
      'ProxyJump for "prod" in ~/.ssh/config ignored — the credential\'s own jump hosts take precedence',
    ]);
    expect(warned).toEqual([]);
  });

  it('warns about ProxyCommand once per host per session (Q5-2)', () => {
    const route = resolveRoute(credential({ host: 'cmd', useSshConfig: true }), deps);
    reportRouteNotices(route, providers);
    reportRouteNotices(route, providers);
    expect(warned).toEqual([
      'FileFerry: ProxyCommand isn\'t supported — use ProxyJump or explicit jump hosts. Connecting to "cmd" directly.',
    ]);
    expect(logged).toEqual([]);

    const hopRoute = resolveRoute(credential({ host: 'cmd-hop', useSshConfig: true }), deps);
    reportRouteNotices(hopRoute, providers);
    expect(warned).toHaveLength(2);
    expect(warned[1]).toContain('"bastion-cmd"');
  });

  it('is silent for a plain route', () => {
    reportRouteNotices(resolveRoute(credential({ useSshConfig: true }), deps), providers);
    expect(logged).toEqual([]);
    expect(warned).toEqual([]);
  });
});
