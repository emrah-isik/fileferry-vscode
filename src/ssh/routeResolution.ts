import type { ServerConfig } from '../types';
import type { ConnectProviders } from './connectProviders';
import {
  applySshConfig,
  PROXY_COMMAND_UNSUPPORTED,
  resolveChain,
  ResolvedHop,
  resolveHostAlias,
  ResolverDeps,
} from './SshConfigResolver';

/**
 * Route resolution (feature 18b): the ONE place that decides how a credential
 * reaches its target — its own `jumpHosts` (credential ids) or, when the
 * credential opts into `~/.ssh/config` and has no explicit hops, the alias's
 * `ProxyJump` chain. Both `SftpService.connect()` and the SSH terminal call
 * this so a server takes the same route whichever consumer opens it.
 *
 * Precedence (Q5-1): explicit `jumpHosts` win; an ignored `ProxyJump` is
 * noted once per alias per session in the output channel. `ProxyCommand`
 * (Q5-2) is never executed — the host is dialed directly and the user is
 * warned once per host per session. This module must stay free of `vscode`
 * imports; the warning reaches the UI through the registry's `warn` sink.
 */

/** A hop of the chain: a stored credential's id, or a hop derived from `~/.ssh/config` (never stored). */
export type ChainHop = string | ResolvedHop;

export function isConfigHop(hop: ChainHop): hop is ResolvedHop {
  return typeof hop !== 'string';
}

export type RouteSource = Pick<ServerConfig, 'host' | 'port' | 'username' | 'privateKeyPath' | 'useSshConfig' | 'jumpHosts'>;

export interface ResolvedRoute<T> {
  /** The target with `~/.ssh/config` applied when it opts in — dial this. */
  target: T;
  hops: ChainHop[];
  /** Output-channel notes (no secrets); `reportRouteNotices` emits each once per session. */
  notes: string[];
  /** Aliases whose block carries a `ProxyCommand` — warned once per host per session, then dialed directly. */
  proxyCommandHosts: string[];
}

export function resolveRoute<T extends RouteSource>(credential: T, deps: ResolverDeps = {}): ResolvedRoute<T> {
  const explicitHops = credential.jumpHosts ?? [];
  if (!credential.useSshConfig) {
    return { target: credential, hops: explicitHops, notes: [], proxyCommandHosts: [] };
  }

  const alias = credential.host;
  const resolved = resolveHostAlias(alias, deps);
  const target = applySshConfig(credential, resolved);
  const notes: string[] = [];
  const proxyCommandHosts: string[] = [];
  if (resolved.proxyCommand) {
    proxyCommandHosts.push(alias);
  }

  if (explicitHops.length > 0) {
    if (resolved.proxyJump) {
      notes.push(`ProxyJump for "${alias}" in ~/.ssh/config ignored — the credential's own jump hosts take precedence`);
    }
    return { target, hops: explicitHops, notes, proxyCommandHosts };
  }

  // Throws SshConfigChainError on a cycle / too many hops — the connect fails
  // with that message rather than silently going direct.
  const hops = resolveChain(alias, deps);
  for (const hop of hops) {
    if (hop.proxyCommand) {
      proxyCommandHosts.push(hop.alias);
    }
  }
  return { target, hops, notes, proxyCommandHosts };
}

// Session-scoped dedupe for the notices (once per alias / host per extension
// session). Module state is the session: the extension host is one process.
const emittedNotices = new Set<string>();

export function resetRouteNoticesForTests(): void {
  emittedNotices.clear();
}

/** Emits the route's notes (log) and ProxyCommand warnings (warn), each once per session. */
export function reportRouteNotices(
  route: Pick<ResolvedRoute<unknown>, 'notes' | 'proxyCommandHosts'>,
  providers: Pick<ConnectProviders, 'log' | 'warn'>
): void {
  for (const note of route.notes) {
    if (!emittedNotices.has(`note:${note}`)) {
      emittedNotices.add(`note:${note}`);
      providers.log(note);
    }
  }
  for (const host of route.proxyCommandHosts) {
    const key = `proxycommand:${host.toLowerCase()}`;
    if (!emittedNotices.has(key)) {
      emittedNotices.add(key);
      providers.warn(`FileFerry: ${PROXY_COMMAND_UNSUPPORTED} Connecting to "${host}" directly.`);
    }
  }
}
