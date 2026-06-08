import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ServerConfig } from '../types';

export interface ResolvedSshConfig {
  hostName?: string;
  port?: number;
  user?: string;
  identityFile?: string; // tilde-expanded absolute-ish path
}

export interface ResolverDeps {
  /** Path to the SSH config file. Defaults to <homeDir>/.ssh/config. */
  configPath?: string;
  /** Home directory used for tilde expansion. Defaults to os.homedir(). */
  homeDir?: string;
  /** Reads the config file, returning its text or null if it does not exist. Injected for tests. */
  readFile?: (filePath: string) => string | null;
}

// Only the connection directives we support in v1. ProxyJump/ProxyCommand and
// Match blocks are intentionally out of scope (see docs/plans/feature_19_plan.md).
const SUPPORTED = new Set(['hostname', 'port', 'user', 'identityfile']);

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Translate an OpenSSH Host pattern (with * and ?) into an anchored RegExp.
function patternToRegExp(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

function expandTilde(value: string, homeDir: string): string {
  if (value === '~') {
    return homeDir;
  }
  if (value.startsWith('~/')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

interface ResolutionDetail {
  configFound: boolean; // the ~/.ssh/config file exists and was readable
  matched: boolean;     // at least one Host block matched the alias
  values: ResolvedSshConfig;
}

function readAndResolve(alias: string, deps: ResolverDeps): ResolutionDetail {
  const homeDir = deps.homeDir ?? os.homedir();
  const configPath = deps.configPath ?? path.join(homeDir, '.ssh', 'config');
  const read = deps.readFile ?? defaultReadFile;

  const text = read(configPath);
  if (!text) {
    return { configFound: false, matched: false, values: {} };
  }

  const resolved: Record<string, string> = {};
  let blockMatches = false;
  let everMatched = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Split "key value" or "key=value"; keyword is case-insensitive.
    const eq = line.indexOf('=');
    const sp = line.search(/\s/);
    let sepIndex: number;
    if (eq === -1) {
      sepIndex = sp;
    } else if (sp === -1) {
      sepIndex = eq;
    } else {
      sepIndex = Math.min(eq, sp);
    }
    if (sepIndex === -1) {
      continue;
    }
    const keyword = line.slice(0, sepIndex).toLowerCase();
    const value = line.slice(sepIndex + 1).replace(/^[=\s]+/, '').trim();
    if (!value) {
      continue;
    }

    if (keyword === 'host') {
      blockMatches = value
        .split(/\s+/)
        .some(pattern => patternToRegExp(pattern).test(alias));
      everMatched = everMatched || blockMatches;
      continue;
    }

    if (blockMatches && SUPPORTED.has(keyword) && resolved[keyword] === undefined) {
      resolved[keyword] = value;
    }
  }

  const result: ResolvedSshConfig = {};
  if (resolved.hostname) {
    result.hostName = resolved.hostname;
  }
  if (resolved.port && /^\d+$/.test(resolved.port)) {
    result.port = parseInt(resolved.port, 10);
  }
  if (resolved.user) {
    result.user = resolved.user;
  }
  if (resolved.identityfile) {
    result.identityFile = expandTilde(resolved.identityfile, homeDir);
  }
  return { configFound: true, matched: everMatched, values: result };
}

/**
 * Resolves an `~/.ssh/config` Host alias to its connection settings.
 *
 * Follows OpenSSH "first obtained value wins" semantics: for each keyword, the
 * value from the earliest matching Host block in file order takes effect. A
 * missing config file or no matching block yields an empty result (never throws).
 */
export function resolveHostAlias(alias: string, deps: ResolverDeps = {}): ResolvedSshConfig {
  return readAndResolve(alias, deps).values;
}

export interface ResolutionSummary {
  status: 'no-file' | 'no-match' | 'matched';
  lines: string[]; // [0] is the headline; any following lines are override notes
}

/**
 * Produces user-facing feedback about what `~/.ssh/config` resolution did for a
 * credential, so alias mode is never silent. Reports whether the file was found,
 * whether the alias matched, the effective connection target, and any explicitly
 * entered values that the config overrode. Pure (injectable reader) and testable.
 */
export function describeResolution(
  entered: { host: string; port?: number; username?: string; privateKeyPath?: string; authMethod?: string },
  deps: ResolverDeps = {}
): ResolutionSummary {
  const detail = readAndResolve(entered.host, deps);

  if (!detail.configFound) {
    return { status: 'no-file', lines: ['No ~/.ssh/config found — using the values entered here.'] };
  }
  if (!detail.matched) {
    return {
      status: 'no-match',
      lines: [`No matching Host entry for "${entered.host}" in ~/.ssh/config — using the values entered here.`],
    };
  }

  const { values } = detail;
  const host = values.hostName ?? entered.host;
  const port = values.port ?? entered.port ?? 22;
  const user = values.user ?? (entered.username || '(no user)');
  // The resolved IdentityFile is only used when the auth method is a key —
  // password/agent/keyboard-interactive ignore it, so don't claim it here.
  const usesKey = entered.authMethod === 'key';
  const key = usesKey ? (values.identityFile ?? (entered.privateKeyPath || undefined)) : undefined;

  // Headline names the alias; the resolved target (and key, for key auth) follow
  // as their own lines so the layout reads cleanly at any panel width.
  const lines = [
    `Resolved "${entered.host}" from ~/.ssh/config`,
    `Target: ${user}@${host}:${port}`,
  ];
  if (key) {
    lines.push(`Key: ${key}`);
  }

  // Override notes: only when the user explicitly entered a value AND the config
  // supplies a different one (host is the alias itself, so it never "overrides").
  if (values.user && entered.username && entered.username !== values.user) {
    lines.push(`Note: ~/.ssh/config overrides Username (${entered.username} → ${values.user}).`);
  }
  if (values.port && entered.port && entered.port !== values.port) {
    lines.push(`Note: ~/.ssh/config overrides Port (${entered.port} → ${values.port}).`);
  }
  if (usesKey && values.identityFile && entered.privateKeyPath && entered.privateKeyPath !== values.identityFile) {
    lines.push(`Note: ~/.ssh/config overrides Private Key (${entered.privateKeyPath} → ${values.identityFile}).`);
  }
  return { status: 'matched', lines };
}

/**
 * Merges resolved `~/.ssh/config` values into a ServerConfig. Config wins; the
 * server's own value is the fallback when the config omits a directive. When no
 * HostName is configured, the original host (the alias) is kept. Pure — returns
 * a new object and never mutates the input.
 */
export function applySshConfig<T extends ServerConfig>(server: T, resolved: ResolvedSshConfig): T {
  return {
    ...server,
    host: resolved.hostName ?? server.host,
    port: resolved.port ?? server.port,
    username: resolved.user ?? server.username,
    privateKeyPath: resolved.identityFile ?? server.privateKeyPath,
  };
}
