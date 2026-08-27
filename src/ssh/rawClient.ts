import type { Client } from 'ssh2';
import type SftpClient from 'ssh2-sftp-client';

/**
 * Typed accessor for the ssh2 `Client` that ssh2-sftp-client wraps.
 *
 * The wrapper keeps it on `.client`, which is not part of its published type
 * surface — this is the single place that reaches through, so every SSH-level
 * feature (keyboard-interactive, exec, port forwarding) shares one accessor
 * instead of a hand-rolled cast.
 */
export function getRawClient(sftp: SftpClient): Client {
  const rawClient = (sftp as unknown as { client?: Client }).client;
  if (!rawClient) {
    throw new Error('ssh2-sftp-client exposed no underlying ssh2 client');
  }
  return rawClient;
}
