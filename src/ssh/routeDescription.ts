import type { SshCredential } from '../models/SshCredential';
import { resolveRoute } from './routeResolution';
import type { ResolverDeps } from './SshConfigResolver';

/**
 * Human-readable route for a credential — `local → hop… → target` — from the
 * non-secret credential list (the Servers tooltip and the terminal banner,
 * 18a-2b/20/18b). Explicit hops are named through their credentials (a
 * deleted one shows as `(missing jump host)`); an `~/.ssh/config` alias shows
 * its resolved `ProxyJump` chain and resolved target, or the reason the chain
 * cannot be followed. Mirrors `resolveRoute`, so what the tooltip says is what
 * the connect will do. Never throws.
 */
export function describeRoute(credential: SshCredential, credentials: SshCredential[], deps?: ResolverDeps): string {
  const stops: string[] = [];
  let target: Pick<SshCredential, 'username' | 'host' | 'port'> = credential;
  try {
    const route = resolveRoute(credential, deps);
    target = route.target;
    for (const hop of route.hops) {
      if (typeof hop === 'string') {
        const hopCredential = credentials.find((candidate) => candidate.id === hop);
        stops.push(hopCredential ? `${hopCredential.username}@${hopCredential.host}:${hopCredential.port}` : '(missing jump host)');
      } else {
        stops.push(`${hop.user}@${hop.host}:${hop.port}`);
      }
    }
  } catch (error: unknown) {
    stops.push(`(${error instanceof Error ? error.message : String(error)})`);
  }
  stops.push(`${target.username}@${target.host}:${target.port}`);
  return `local → ${stops.join(' → ')}`;
}
