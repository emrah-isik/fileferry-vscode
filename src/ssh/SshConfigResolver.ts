import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ServerConfig } from '../types';

export interface ResolvedSshConfig {
  hostName?: string;
  port?: number;
  user?: string;
  identityFile?: string; // tilde-expanded absolute-ish path
  /**
   * Raw `ProxyJump` value — a comma-separated list of `[user@]host[:port]`
   * tokens (feature 18b). Absent for `ProxyJump none`. Resolve it with
   * `resolveChain`; only one of `proxyJump`/`proxyCommand` is ever set
   * (OpenSSH: whichever is specified first wins).
   */
  proxyJump?: string;
  /** Raw `ProxyCommand` value — detected so callers can warn; NEVER executed (Q5-2). */
  proxyCommand?: string;
}

export interface ResolverDeps {
  /** Path to the SSH config file. Defaults to <homeDir>/.ssh/config. */
  configPath?: string;
  /** Home directory used for tilde expansion. Defaults to os.homedir(). */
  homeDir?: string;
  /** Reads the config file, returning its text or null if it does not exist. Injected for tests. */
  readFile?: (filePath: string) => string | null;
  /**
   * Login name for a ProxyJump host that names no user — OpenSSH uses the
   * local user there. Defaults to the current OS user.
   */
  localUser?: string;
}

/** One hop of a resolved `ProxyJump` chain, in connect order (feature 18b, Q4). */
export interface ResolvedHop {
  /** The ProxyJump token's host part — a `Host` alias or a literal hostname. */
  alias: string;
  host: string;
  port: number;
  user: string;
  /** Tilde-expanded `IdentityFile` from the hop's own block, when it has one. */
  identityFile?: string;
  /** The hop's own block carries a `ProxyCommand` — ignored and warned about, never run. */
  proxyCommand?: string;
}

/** Q4: a ProxyJump chain longer than this is refused rather than followed. */
export const MAX_PROXY_JUMP_HOPS = 8;

/** A `ProxyJump` chain that cannot be followed: an alias cycle or too many hops. */
export class SshConfigChainError extends Error {
  constructor(readonly alias: string, message: string) {
    super(message);
    this.name = 'SshConfigChainError';
  }
}

// The connection directives we resolve. `ProxyJump`/`ProxyCommand` are read
// (18b); `Match` blocks stay out of scope but terminate the current block;
// `Include` is unsupported.
const SUPPORTED = new Set(['hostname', 'port', 'user', 'identityfile', 'proxyjump', 'proxycommand']);

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function defaultLocalUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'root';
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

    if (keyword === 'match') {
      // M6: Match blocks are not evaluated, but they END the preceding Host
      // block — its directives must not be attributed to that block.
      blockMatches = false;
      continue;
    }

    if (!blockMatches || !SUPPORTED.has(keyword) || resolved[keyword] !== undefined) {
      continue;
    }
    // OpenSSH: ProxyJump and ProxyCommand compete — whichever is specified
    // first prevents later instances of the other from taking effect.
    if (keyword === 'proxyjump' && resolved.proxycommand !== undefined) {
      continue;
    }
    if (keyword === 'proxycommand' && resolved.proxyjump !== undefined) {
      continue;
    }
    resolved[keyword] = value;
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
  if (resolved.proxyjump && resolved.proxyjump.toLowerCase() !== 'none') {
    result.proxyJump = resolved.proxyjump;
  }
  if (resolved.proxycommand && resolved.proxycommand.toLowerCase() !== 'none') {
    result.proxyCommand = resolved.proxycommand;
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

interface ProxyJumpToken {
  user?: string;
  host: string;
  port?: number;
}

// `[user@]host[:port]` — the host may be a bracketed IPv6 literal.
function parseProxyJumpToken(token: string): ProxyJumpToken | null {
  const match = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/.exec(token.trim());
  if (!match) {
    return null;
  }
  const host = match[2].startsWith('[') ? match[2].slice(1, -1) : match[2];
  return {
    user: match[1] || undefined,
    host,
    port: match[3] ? parseInt(match[3], 10) : undefined,
  };
}

/**
 * Resolves the `ProxyJump` chain for an alias into hops in connect order
 * (feature 18b, Q4). Each jump is looked up as its own `Host` block — with its
 * own HostName/Port/User/IdentityFile and its own `ProxyJump`, followed
 * recursively (a jump's own jumps come before it). Comma-separated multi-jump
 * and literal `[user@]host[:port]` tokens are supported; a literal user/port
 * overrides the block's. A hop with no user anywhere gets the local user
 * (OpenSSH behaviour). Never returns more than `MAX_PROXY_JUMP_HOPS` hops and
 * refuses alias cycles — both throw `SshConfigChainError`. No config file or
 * no `ProxyJump` → `[]`.
 */
export function resolveChain(alias: string, deps: ResolverDeps = {}): ResolvedHop[] {
  const localUser = deps.localUser ?? defaultLocalUser();
  const hops: ResolvedHop[] = [];

  const walk = (currentAlias: string, ancestry: string[]): void => {
    const proxyJump = readAndResolve(currentAlias, deps).values.proxyJump;
    if (!proxyJump) {
      return;
    }
    for (const rawToken of proxyJump.split(',')) {
      if (!rawToken.trim()) {
        continue;
      }
      const token = parseProxyJumpToken(rawToken);
      if (!token) {
        throw new SshConfigChainError(alias, `ProxyJump "${rawToken.trim()}" (for "${currentAlias}") is not a valid [user@]host[:port]`);
      }
      const chain = [...ancestry, currentAlias];
      if (chain.some(seen => seen.toLowerCase() === token.host.toLowerCase())) {
        throw new SshConfigChainError(alias, `ProxyJump loop in ~/.ssh/config: ${[...chain, token.host].join(' → ')}`);
      }
      // The jump's own jumps sit between us and it — resolve them first.
      walk(token.host, chain);

      const hopValues = readAndResolve(token.host, deps).values;
      if (hops.length >= MAX_PROXY_JUMP_HOPS) {
        throw new SshConfigChainError(alias, `ProxyJump chain for "${alias}" has more than ${MAX_PROXY_JUMP_HOPS} hops`);
      }
      const hop: ResolvedHop = {
        alias: token.host,
        host: hopValues.hostName ?? token.host,
        port: token.port ?? hopValues.port ?? 22,
        user: token.user ?? hopValues.user ?? localUser,
      };
      if (hopValues.identityFile) {
        hop.identityFile = hopValues.identityFile;
      }
      if (hopValues.proxyCommand) {
        hop.proxyCommand = hopValues.proxyCommand;
      }
      hops.push(hop);
    }
  };

  walk(alias, []);
  return hops;
}

export interface ResolutionSummary {
  status: 'no-file' | 'no-match' | 'matched';
  lines: string[]; // [0] is the headline; any following lines are override notes
}

/** The Q5-2 warning text — shared by the panel summary and the connect-time warning. */
export const PROXY_COMMAND_UNSUPPORTED = 'ProxyCommand isn\'t supported — use ProxyJump or explicit jump hosts.';

/**
 * Produces user-facing feedback about what `~/.ssh/config` resolution did for a
 * credential, so alias mode is never silent. Reports whether the file was found,
 * whether the alias matched, the effective connection target, the resolved
 * `ProxyJump` route (18b), and any explicitly entered values that the config
 * overrode. Pure (injectable reader) and testable.
 */
export function describeResolution(
  entered: {
    host: string; port?: number; username?: string; privateKeyPath?: string; authMethod?: string;
    /** The credential's own jump hosts — when present they win over `ProxyJump` (Q5-1). */
    jumpHosts?: string[];
  },
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

  // Route (18b): explicit jump hosts win over ProxyJump (Q5-1); otherwise the
  // config chain is shown hop by hop, or the reason it cannot be followed.
  const hasExplicitJumpHosts = (entered.jumpHosts?.length ?? 0) > 0;
  if (values.proxyJump && hasExplicitJumpHosts) {
    lines.push('Note: ProxyJump in ~/.ssh/config is ignored — this credential\'s own jump hosts take precedence.');
  } else if (values.proxyJump) {
    try {
      const hops = resolveChain(entered.host, deps);
      const stops = hops.map(hop => `${hop.user}@${hop.host}:${hop.port}`);
      lines.push(`Route: local → ${[...stops, `${user}@${host}:${port}`].join(' → ')}`);
      for (const hop of hops.filter(candidate => candidate.proxyCommand)) {
        lines.push(`Note: ProxyCommand on "${hop.alias}" isn't supported — use ProxyJump or explicit jump hosts. Connecting to it directly.`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`Note: ProxyJump not usable — ${message}`);
    }
  }
  if (values.proxyCommand) {
    lines.push(`Note: ${PROXY_COMMAND_UNSUPPORTED} Connecting directly.`);
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
export function applySshConfig<T extends Pick<ServerConfig, 'host' | 'port' | 'username' | 'privateKeyPath'>>(
  server: T,
  resolved: ResolvedSshConfig
): T {
  return {
    ...server,
    host: resolved.hostName ?? server.host,
    port: resolved.port ?? server.port,
    username: resolved.user ?? server.username,
    privateKeyPath: resolved.identityFile ?? server.privateKeyPath,
  };
}
