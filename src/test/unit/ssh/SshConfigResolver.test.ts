import * as path from 'path';
import { resolveHostAlias, applySshConfig, describeResolution, resolveChain, SshConfigChainError } from '../../../ssh/SshConfigResolver';
import type { ServerConfig } from '../../../types';

// Inject the config text directly so tests never touch the real filesystem.
function resolver(configText: string | null, homeDir = '/home/dev') {
  return (alias: string) =>
    resolveHostAlias(alias, { homeDir, readFile: () => configText });
}

const SAMPLE = `
# a comment
Host prod
    HostName 203.0.113.10
    Port 2222
    User deploy
    IdentityFile ~/.ssh/prod_ed25519

Host *.example.com
    User www
    Port 22000

Host staging-?
    HostName staging.internal
    User stage
`;

describe('resolveHostAlias', () => {
  it('resolves an exact alias to HostName/Port/User/IdentityFile', () => {
    const r = resolver(SAMPLE)('prod');
    expect(r).toEqual({
      hostName: '203.0.113.10',
      port: 2222,
      user: 'deploy',
      identityFile: path.join('/home/dev', '.ssh/prod_ed25519'),
    });
  });

  it('matches a "*" wildcard pattern', () => {
    const r = resolver(SAMPLE)('api.example.com');
    expect(r.user).toBe('www');
    expect(r.port).toBe(22000);
    expect(r.hostName).toBeUndefined();
  });

  it('matches a "?" single-char wildcard pattern', () => {
    const r = resolver(SAMPLE)('staging-1');
    expect(r.hostName).toBe('staging.internal');
    expect(r.user).toBe('stage');
  });

  it('returns the first obtained value when blocks overlap (first match wins)', () => {
    const cfg = `
Host prod
    User first
Host prod
    User second
    Port 999
`;
    const r = resolver(cfg)('prod');
    expect(r.user).toBe('first');
    expect(r.port).toBe(999); // Port only set by the second block, so it still applies
  });

  it('is case-insensitive on keywords and accepts "=" separators', () => {
    const cfg = `
host prod
  hostname=10.0.0.1
  PORT = 2200
`;
    const r = resolver(cfg)('prod');
    expect(r.hostName).toBe('10.0.0.1');
    expect(r.port).toBe(2200);
  });

  it('returns an empty result when no Host block matches', () => {
    expect(resolver(SAMPLE)('unknown')).toEqual({});
  });

  it('returns an empty result when the config file is missing', () => {
    expect(resolver(null)('prod')).toEqual({});
  });
});

describe('applySshConfig', () => {
  const base: ServerConfig = {
    id: 's1', name: 'Prod', type: 'sftp',
    host: 'prod', port: 22, username: 'fallback',
    authMethod: 'key', privateKeyPath: '~/.ssh/fallback',
    mappings: [], excludedPaths: [],
  };

  it('lets config win and uses the credential value as fallback', () => {
    const merged = applySshConfig(base, {
      hostName: '203.0.113.10', port: 2222, user: 'deploy', identityFile: '/keys/prod',
    });
    expect(merged.host).toBe('203.0.113.10');
    expect(merged.port).toBe(2222);
    expect(merged.username).toBe('deploy');
    expect(merged.privateKeyPath).toBe('/keys/prod');
  });

  it('keeps the credential values when the resolved config omits them', () => {
    const merged = applySshConfig(base, { hostName: '203.0.113.10' });
    expect(merged.host).toBe('203.0.113.10');
    expect(merged.port).toBe(22);
    expect(merged.username).toBe('fallback');
    expect(merged.privateKeyPath).toBe('~/.ssh/fallback');
  });

  it('falls back to the alias as host when config has no HostName', () => {
    const merged = applySshConfig(base, { user: 'deploy' });
    expect(merged.host).toBe('prod');
    expect(merged.username).toBe('deploy');
  });

  it('does not mutate the input server object', () => {
    applySshConfig(base, { port: 2222 });
    expect(base.port).toBe(22);
  });
});

describe('describeResolution', () => {
  function describe_(configText: string | null, entered: any, homeDir = '/home/dev') {
    return describeResolution(entered, { homeDir, readFile: () => configText });
  }

  it('reports no-file when ~/.ssh/config is missing', () => {
    const r = describe_(null, { host: 'prod', port: 22, username: 'forge' });
    expect(r.status).toBe('no-file');
    expect(r.lines[0]).toMatch(/No ~\/\.ssh\/config/);
  });

  it('reports no-match when the file has no matching Host block', () => {
    const r = describe_('Host other\n  HostName 1.1.1.1\n', { host: 'prod', port: 22, username: 'forge' });
    expect(r.status).toBe('no-match');
    expect(r.lines[0]).toMatch(/No matching Host entry for "prod"/);
  });

  it('summarises a full match as headline + target + key lines (key auth)', () => {
    const cfg = 'Host prod\n  HostName 203.0.113.10\n  Port 2222\n  User deploy\n  IdentityFile ~/.ssh/prod_ed25519\n';
    const r = describe_(cfg, { host: 'prod', port: 22, username: '', privateKeyPath: '', authMethod: 'key' });
    expect(r.status).toBe('matched');
    expect(r.lines[0]).toBe('Resolved "prod" from ~/.ssh/config'); // headline carries no target/key
    expect(r.lines).toContain('Target: deploy@203.0.113.10:2222');
    expect(r.lines).toContain(`Key: ${path.join('/home/dev', '.ssh/prod_ed25519')}`);
  });

  it('omits the key line when the auth method is not a key (e.g. password)', () => {
    const cfg = 'Host prod\n  HostName 203.0.113.10\n  Port 2222\n  User deploy\n  IdentityFile ~/.ssh/prod_ed25519\n';
    const r = describe_(cfg, { host: 'prod', port: 22, username: '', authMethod: 'password' });
    expect(r.status).toBe('matched');
    expect(r.lines).toContain('Target: deploy@203.0.113.10:2222');
    expect(r.lines.join('\n')).not.toMatch(/key/i); // password auth never uses the resolved IdentityFile
  });

  it('matches an empty Host block (no supported directives) as matched, using entered values', () => {
    const r = describe_('Host prod\n  ForwardAgent yes\n', { host: 'prod', port: 22, username: 'forge' });
    expect(r.status).toBe('matched');
    expect(r.lines).toContain('Target: forge@prod:22');
  });

  it('adds an override note when the config replaces an explicitly entered value', () => {
    const cfg = 'Host prod\n  HostName 203.0.113.10\n  User git\n';
    const r = describe_(cfg, { host: 'prod', port: 22, username: 'forge' });
    expect(r.status).toBe('matched');
    expect(r.lines.some(l => /overrides Username \(forge → git\)/.test(l))).toBe(true);
  });

  it('does not add an override note when the entered value is blank', () => {
    const cfg = 'Host prod\n  User git\n';
    const r = describe_(cfg, { host: 'prod', port: 22, username: '' });
    expect(r.lines.some(l => /overrides Username/.test(l))).toBe(false);
  });
});

// ─── 18b: ProxyJump / ProxyCommand / Match ───────────────────────────────────

const CHAIN_CONFIG = `
Host target
    HostName 10.0.0.5
    User deploy
    ProxyJump bastion

Host bastion
    HostName bastion.example.com
    Port 2222
    User jump
    IdentityFile ~/.ssh/bastion_ed25519

Host inner
    HostName inner.example.com
    ProxyJump bastion

Host two-hop
    HostName 10.0.0.9
    ProxyJump inner

Host multi
    HostName 10.0.0.7
    ProxyJump bastion,relay@relay.example.com:2200

Host literal
    ProxyJump ops@[2001:db8::1]:2022

Host none
    HostName 10.0.0.8
    ProxyJump none

Host loop-a
    ProxyJump loop-b
Host loop-b
    ProxyJump loop-a

Host cmd
    HostName 10.0.0.6
    ProxyCommand ssh -W %h:%p bastion

Host cmd-hop
    ProxyJump bastion-cmd
Host bastion-cmd
    HostName bc.example.com
    ProxyCommand nc bc 22

Host both-jump-first
    ProxyJump bastion
    ProxyCommand nc x 22
Host both-command-first
    ProxyCommand nc x 22
    ProxyJump bastion
`;

const chainDeps = { homeDir: '/home/dev', localUser: 'localdev', readFile: () => CHAIN_CONFIG };

describe('resolveHostAlias — ProxyJump / ProxyCommand / Match (18b)', () => {
  it('exposes the raw ProxyJump value', () => {
    expect(resolveHostAlias('target', chainDeps).proxyJump).toBe('bastion');
  });

  it('treats "ProxyJump none" as no proxy', () => {
    expect(resolveHostAlias('none', chainDeps).proxyJump).toBeUndefined();
  });

  it('detects ProxyCommand without executing it', () => {
    expect(resolveHostAlias('cmd', chainDeps).proxyCommand).toBe('ssh -W %h:%p bastion');
  });

  it('lets whichever of ProxyJump/ProxyCommand comes first win (OpenSSH semantics)', () => {
    const jumpFirst = resolveHostAlias('both-jump-first', chainDeps);
    expect(jumpFirst.proxyJump).toBe('bastion');
    expect(jumpFirst.proxyCommand).toBeUndefined();
    const commandFirst = resolveHostAlias('both-command-first', chainDeps);
    expect(commandFirst.proxyCommand).toBe('nc x 22');
    expect(commandFirst.proxyJump).toBeUndefined();
  });

  it('ends the current Host block at a Match line instead of attributing its directives (M6)', () => {
    const cfg = `
Host prod
    HostName 203.0.113.10
Match host prod exec "true"
    User matched
    Port 2299
Host prod
    User second
`;
    const resolved = resolveHostAlias('prod', { readFile: () => cfg });
    expect(resolved.hostName).toBe('203.0.113.10');
    expect(resolved.port).toBeUndefined();
    expect(resolved.user).toBe('second');
  });
});

describe('resolveChain', () => {
  it('returns no hops for an alias without ProxyJump', () => {
    expect(resolveChain('bastion', chainDeps)).toEqual([]);
    expect(resolveChain('none', chainDeps)).toEqual([]);
    expect(resolveChain('unknown', chainDeps)).toEqual([]);
  });

  it('resolves a single jump through its own Host block (HostName/Port/User/IdentityFile)', () => {
    expect(resolveChain('target', chainDeps)).toEqual([{
      alias: 'bastion',
      host: 'bastion.example.com',
      port: 2222,
      user: 'jump',
      identityFile: path.join('/home/dev', '.ssh/bastion_ed25519'),
    }]);
  });

  it('resolves nested ProxyJump recursively, outermost hop first', () => {
    const hops = resolveChain('two-hop', chainDeps);
    expect(hops.map(hop => hop.alias)).toEqual(['bastion', 'inner']);
    expect(hops[1]).toMatchObject({ host: 'inner.example.com', port: 22, user: 'localdev' });
  });

  it('supports comma-separated multi-jump with literal user@host:port tokens', () => {
    const hops = resolveChain('multi', chainDeps);
    expect(hops.map(hop => `${hop.user}@${hop.host}:${hop.port}`)).toEqual([
      'jump@bastion.example.com:2222',
      'relay@relay.example.com:2200',
    ]);
    expect(hops[1].alias).toBe('relay.example.com');
  });

  it('parses a bracketed IPv6 literal with user and port', () => {
    expect(resolveChain('literal', chainDeps)).toEqual([
      { alias: '2001:db8::1', host: '2001:db8::1', port: 2022, user: 'ops' },
    ]);
  });

  it('falls back to the local user when neither the token nor the block names one', () => {
    expect(resolveChain('two-hop', chainDeps)[1].user).toBe('localdev');
  });

  it('refuses an alias cycle with a clear message', () => {
    expect(() => resolveChain('loop-a', chainDeps)).toThrow(SshConfigChainError);
    expect(() => resolveChain('loop-a', chainDeps)).toThrow(/ProxyJump loop.*loop-a → loop-b → loop-a/);
  });

  it('caps the chain at 8 hops', () => {
    const lines = ['Host h0', '    ProxyJump h1'];
    for (let i = 1; i <= 9; i++) {
      lines.push(`Host h${i}`, `    HostName 10.0.0.${i}`, `    ProxyJump h${i + 1}`);
    }
    lines.push('Host h10', '    HostName 10.0.0.10');
    const deep = { localUser: 'u', readFile: () => lines.join('\n') };
    expect(() => resolveChain('h0', deep)).toThrow(/more than 8 hops/);

    const okLines = lines.slice(0, 2 + 7 * 3).concat(['Host h8', '    HostName 10.0.0.8']);
    expect(resolveChain('h0', { localUser: 'u', readFile: () => okLines.join('\n') })).toHaveLength(8);
  });

  it('carries a hop\'s ProxyCommand so callers can warn (never executes it)', () => {
    const hops = resolveChain('cmd-hop', chainDeps);
    expect(hops).toHaveLength(1);
    expect(hops[0]).toMatchObject({ alias: 'bastion-cmd', host: 'bc.example.com', proxyCommand: 'nc bc 22' });
  });

  it('returns no hops when the config file is missing', () => {
    expect(resolveChain('target', { readFile: () => null })).toEqual([]);
  });
});

describe('describeResolution — route (18b)', () => {
  function describeChain(entered: any) {
    return describeResolution(entered, chainDeps);
  }

  it('shows the resolved route when the alias has a ProxyJump', () => {
    const summary = describeChain({ host: 'target', port: 22, username: '', authMethod: 'password' });
    expect(summary.status).toBe('matched');
    expect(summary.lines).toContain('Target: deploy@10.0.0.5:22');
    expect(summary.lines).toContain('Route: local → jump@bastion.example.com:2222 → deploy@10.0.0.5:22');
  });

  it('shows every hop of a nested chain in connect order', () => {
    const summary = describeChain({ host: 'two-hop', port: 22, username: 'deploy', authMethod: 'password' });
    expect(summary.lines).toContain(
      'Route: local → jump@bastion.example.com:2222 → localdev@inner.example.com:22 → deploy@10.0.0.9:22'
    );
  });

  it('adds no route line for a direct alias', () => {
    const summary = describeChain({ host: 'bastion', port: 22, username: '', authMethod: 'key' });
    expect(summary.lines.some(line => line.startsWith('Route:'))).toBe(false);
  });

  it('notes that ProxyJump is ignored when the credential has explicit jump hosts (Q5-1)', () => {
    const summary = describeChain({ host: 'target', port: 22, username: '', authMethod: 'password', jumpHosts: ['cred-1'] });
    expect(summary.lines.some(line => line.startsWith('Route:'))).toBe(false);
    expect(summary.lines).toContain(
      'Note: ProxyJump in ~/.ssh/config is ignored — this credential\'s own jump hosts take precedence.'
    );
  });

  it('names an unsupported ProxyCommand on the target (Q5-2)', () => {
    const summary = describeChain({ host: 'cmd', port: 22, username: 'deploy', authMethod: 'password' });
    expect(summary.lines).toContain('Note: ProxyCommand isn\'t supported — use ProxyJump or explicit jump hosts. Connecting directly.');
  });

  it('names an unsupported ProxyCommand on a hop', () => {
    const summary = describeChain({ host: 'cmd-hop', port: 22, username: 'deploy', authMethod: 'password' });
    expect(summary.lines).toContain('Route: local → localdev@bc.example.com:22 → deploy@cmd-hop:22');
    expect(summary.lines).toContain('Note: ProxyCommand on "bastion-cmd" isn\'t supported — use ProxyJump or explicit jump hosts. Connecting to it directly.');
  });

  it('reports a chain error instead of a route', () => {
    const summary = describeChain({ host: 'loop-a', port: 22, username: 'deploy', authMethod: 'password' });
    expect(summary.lines.some(line => /^Note: ProxyJump not usable — ProxyJump loop/.test(line))).toBe(true);
  });
});
