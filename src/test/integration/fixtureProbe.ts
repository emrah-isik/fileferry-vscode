import { spawnSync } from 'child_process';

/**
 * Fixture availability probe for the integration suites (R8-15): when the
 * docker fixture is down the suites must SKIP with a clear message, not
 * throw. Jest only honours `describe.skip` at collection time (synchronous),
 * so the TCP probe runs in a short-lived synchronous node subprocess.
 */

const PROBE_TIMEOUT_MS = 1500;

export function isTcpPortReachable(host: string, port: number): boolean {
  const probeScript = `
    const net = require('net');
    const socket = net.connect(${port}, ${JSON.stringify(host)});
    socket.setTimeout(${PROBE_TIMEOUT_MS});
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => process.exit(1));
  `;
  const result = spawnSync(process.execPath, ['-e', probeScript], { timeout: PROBE_TIMEOUT_MS + 2000 });
  return result.status === 0;
}

export const SSH_FIXTURE_START_HINT =
  'Start it with: docker compose -f dev/ssh-test/docker-compose.yml up -d --build';

export const FTP_FIXTURE_START_HINT =
  'Start it with: docker start fileferry-ftp (see src/test/integration/README.md)';

/**
 * Returns `describe` when the fixture answers on host:port, `describe.skip`
 * (after logging why) when it does not. Usage:
 *
 *   const describeIntegration = describeIfFixtureUp('SSH fixture', HOST, PORT, SSH_FIXTURE_START_HINT);
 *   describeIntegration('my suite', () => { … });
 */
export function describeIfFixtureUp(
  label: string,
  host: string,
  port: number,
  startHint: string
): jest.Describe {
  if (isTcpPortReachable(host, port)) {
    return describe;
  }
  console.warn(`[integration] ${label} is not reachable at ${host}:${port} — SKIPPING this suite. ${startHint}`);
  return describe.skip;
}
