/**
 * Drives a `hostVerifier` exactly the way ssh2 does, so a test fails if the
 * verifier's *shape* is wrong — not just its eventual value.
 *
 * Reproduces `node_modules/ssh2/lib/client.js:281-286`:
 *
 *     const ret = hashCb(key, verify);
 *     if (ret !== undefined) verify(ret);
 *
 * and the verdict rule in `lib/protocol/kex.js:1200-1204`: the handshake is
 * rejected only when `permitted === false`. Any other value — including a
 * pending Promise returned by an `async` verifier — is truthy and accepts the
 * host immediately, before the prompt has resolved.
 */
export function driveSsh2HostVerifier(
  hostVerifier: (key: Buffer, verify: (permitted: unknown) => void) => unknown,
  key: Buffer
): Promise<boolean> {
  return new Promise((resolve) => {
    const verify = (permitted: unknown) => resolve(permitted !== false);
    const ret = hostVerifier(key, verify);
    if (ret !== undefined) {
      verify(ret);
    }
  });
}
