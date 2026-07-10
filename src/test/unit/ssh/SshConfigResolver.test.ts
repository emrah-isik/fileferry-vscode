import * as path from 'path';
import { resolveHostAlias, applySshConfig, describeResolution } from '../../../ssh/SshConfigResolver';
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
