import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

/**
 * Ref-counted pool of live jump-host (bastion) connections — feature 18a-2a.
 *
 * The pool shares HOP connections only (Q13): every SFTP session through a
 * bastion runs `forwardOut` over one shared ssh2 client per hop, so the
 * bastion's MFA is asked once per idle window instead of once per session.
 * Target sessions are never pooled (named follow-up).
 *
 * This module must stay free of `vscode` imports — the singleton is created in
 * `extension.ts` and reaches `chainConnect` through the connect-provider
 * registry (R8-3); unit tests drive it with a fake `createClient` factory.
 */

export const JUMP_HOST_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // Q14: last release → 5-minute idle timer

// Q23: pooled hops keep themselves alive and notice a dead peer within ~45 s.
const KEEPALIVE_INTERVAL_MS = 15000;
const KEEPALIVE_COUNT_MAX = 3;

export interface JumpHostTarget {
  username: string;
  host: string;
  port: number;
}

/**
 * Prepares one dial attempt: registers the keyboard-interactive listener and
 * host verifier on the fresh client (R8-18), opens the carrying sock for hops
 * beyond the first, and returns the ssh2 ConnectConfig. Called again for every
 * reconnect — the retry after a failed forwardOut included — so each attempt
 * gets a fresh sock and fresh prompt state. `abortConnect` fails the pending
 * connect (e.g. the user dismissed a prompt); the pool then ends the client.
 */
export interface JumpHostDialer {
  prepare(client: Client, abortConnect: (reason: Error) => void): Promise<ConnectConfig>;
}

export interface JumpHostAcquireRequest {
  target: JumpHostTarget;
  /** Credential id behind this acquire — only used for the first-connected-wins log (R8-4). */
  sourceId: string;
  dialer: JumpHostDialer;
}

/** A lease on one pooled hop. Release exactly once; forwardOut retries once after a failure (R8-10). */
export interface JumpHostHandle {
  readonly key: string;
  forwardOut(
    sourceHost: string,
    sourcePort: number,
    destinationHost: string,
    destinationPort: number
  ): Promise<ClientChannel>;
  release(): void;
}

interface PoolConnection {
  client: Client;
  sourceId: string;
}

/**
 * One per canonical key. Survives eviction/reconnect so the ref-count held by
 * outstanding handles is never lost when the underlying client is replaced.
 */
interface PoolSlot {
  key: string;
  refCount: number;
  /** Set by drain() while held (R6): the last release closes instead of idling. */
  closeOnLastRelease: boolean;
  connection: PoolConnection | undefined;
  connecting: Promise<void> | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The most recent request — reconnects (eviction, forwardOut retry) re-dial with it. */
  lastRequest: JumpHostAcquireRequest;
}

export interface JumpHostPoolOptions {
  createClient: () => Client;
  log: (line: string) => void;
}

function isAuthFailure(error: unknown): boolean {
  return /authentication methods failed/i.test((error as Error)?.message ?? '');
}

export class JumpHostPool {
  private readonly slots = new Map<string, PoolSlot>();
  private readonly evictListeners = new Set<(key: string) => void>();

  constructor(private readonly options: JumpHostPoolOptions) {}

  /** Canonical pool key (Q27): `user@hostname:port` after resolution, hostname lowercased. */
  static keyFor(target: JumpHostTarget): string {
    return `${target.username}@${target.host.toLowerCase()}:${target.port}`;
  }

  /** Fired when a live hop drops unexpectedly (close/error) — never for deliberate closes (idle, drain, release). */
  onDidEvict(listener: (key: string) => void): { dispose(): void } {
    this.evictListeners.add(listener);
    return { dispose: () => this.evictListeners.delete(listener) };
  }

  async acquire(request: JumpHostAcquireRequest): Promise<JumpHostHandle> {
    const key = JumpHostPool.keyFor(request.target);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = {
        key,
        refCount: 0,
        closeOnLastRelease: false,
        connection: undefined,
        connecting: undefined,
        idleTimer: undefined,
        lastRequest: request,
      };
      this.slots.set(key, slot);
    }

    try {
      await this.ensureConnected(slot, request);
    } catch (error: unknown) {
      if (slot.refCount === 0 && !slot.connection && !slot.connecting) {
        this.slots.delete(key);
      }
      throw error;
    }

    slot.refCount += 1;
    this.clearIdleTimer(slot);
    return this.createHandle(slot);
  }

  /** Disconnect semantics (Q25/R6): close idle hops now, mark held hops close-on-last-release. Never cuts a hop under a live session. */
  drain(): void {
    for (const slot of [...this.slots.values()]) {
      if (slot.refCount === 0) {
        this.options.log(`drain: closing idle jump host ${slot.key}`);
        this.clearIdleTimer(slot);
        this.closeConnection(slot);
      } else {
        this.options.log(`drain: jump host ${slot.key} is in use — will close on last release`);
        slot.closeOnLastRelease = true;
      }
    }
  }

  /**
   * Credential change (18a-2b, H3/Q14): closes every hop that was dialed with
   * this credential — the live connection authenticated with the OLD data.
   * Unlike drain, this fires `onDidEvict`: holders' sessions ride the closed
   * client, so consumers (Remote Files) must get to react.
   */
  evictBySourceId(credentialId: string): void {
    for (const slot of [...this.slots.values()]) {
      if (slot.connection?.sourceId !== credentialId) {
        continue;
      }
      this.options.log(`credential for jump host ${slot.key} changed — evicting from the pool`);
      this.clearIdleTimer(slot);
      this.closeConnection(slot);
      for (const listener of [...this.evictListeners]) {
        listener(slot.key);
      }
    }
  }

  /** Test/deactivation teardown: closes everything, held or not. */
  dispose(): void {
    for (const slot of [...this.slots.values()]) {
      this.clearIdleTimer(slot);
      this.closeConnection(slot);
      this.slots.delete(slot.key);
    }
    this.evictListeners.clear();
  }

  private createHandle(slot: PoolSlot): JumpHostHandle {
    let released = false;
    return {
      key: slot.key,
      forwardOut: (sourceHost, sourcePort, destinationHost, destinationPort) =>
        this.forwardOut(slot, sourceHost, sourcePort, destinationHost, destinationPort),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.release(slot);
      },
    };
  }

  private async ensureConnected(slot: PoolSlot, request: JumpHostAcquireRequest): Promise<void> {
    slot.lastRequest = request;
    if (slot.connection) {
      if (slot.connection.sourceId !== request.sourceId) {
        // Q27/R8-4: two credentials resolving to the same key — first-connected wins.
        this.options.log(
          `jump host ${slot.key} is already connected (credential ${slot.connection.sourceId}) — first-connected wins, reusing`
        );
      }
      return;
    }

    // Q26/R8-8: concurrent acquirers await one login. A cancelled dial rejects
    // every waiter; an auth failure gives each waiter one retry of its own
    // (waiters joining an already-running retry share that attempt — no
    // parallel logins, no prompt storm).
    let retried = false;
    for (;;) {
      let flight = slot.connecting;
      if (!flight) {
        // The finally runs before any waiter's continuation, so a retrying
        // waiter always sees the in-flight cache already cleared.
        const flightRef: Promise<void> = this.dial(slot, request).finally(() => {
          if (slot.connecting === flightRef) {
            slot.connecting = undefined;
          }
        });
        flight = flightRef;
        slot.connecting = flight;
      }
      try {
        await flight;
        return;
      } catch (error: unknown) {
        if (isAuthFailure(error) && !retried) {
          retried = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async dial(slot: PoolSlot, request: JumpHostAcquireRequest): Promise<void> {
    const client = this.options.createClient();

    let rejectConnect: ((error: Error) => void) | undefined;
    let abortedWith: Error | undefined;
    const abortConnect = (reason: Error): void => {
      abortedWith = reason;
      rejectConnect?.(reason);
      client.end();
    };

    const config = await request.dialer.prepare(client, abortConnect);

    await new Promise<void>((resolve, reject) => {
      if (abortedWith) {
        reject(abortedWith);
        return;
      }
      rejectConnect = reject;
      const onReady = (): void => {
        client.removeListener('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        client.removeListener('ready', onReady);
        reject(error);
      };
      client.once('ready', onReady);
      client.once('error', onError);
      client.connect({
        ...config,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      });
    });

    // Post-ready errors would crash the process without a listener; 'close'
    // follows and carries the eviction.
    client.on('error', () => undefined);
    const connection: PoolConnection = { client, sourceId: request.sourceId };
    slot.connection = connection;
    client.on('close', () => this.handleUnexpectedClose(slot, connection));
  }

  private handleUnexpectedClose(slot: PoolSlot, connection: PoolConnection): void {
    if (slot.connection !== connection) {
      return; // deliberate close, or already replaced by a reconnect
    }
    slot.connection = undefined;
    this.clearIdleTimer(slot);
    if (slot.refCount === 0) {
      this.slots.delete(slot.key);
    }
    this.options.log(`jump host ${slot.key} connection lost — evicted from the pool`);
    for (const listener of [...this.evictListeners]) {
      listener(slot.key);
    }
  }

  private async forwardOut(
    slot: PoolSlot,
    sourceHost: string,
    sourcePort: number,
    destinationHost: string,
    destinationPort: number
  ): Promise<ClientChannel> {
    // Q23/R8-10: a failed forwardOut (or an already-evicted hop) gets ONE
    // reconnect — which may legitimately re-prompt the bastion's MFA — then
    // one retry of the forward.
    for (let attempt = 0; ; attempt++) {
      if (!slot.connection) {
        this.options.log(`re-authenticating to ${slot.key}`);
        await this.ensureConnected(slot, slot.lastRequest);
      }
      const connection = slot.connection;
      if (!connection) {
        throw new Error(`Jump host ${slot.key} is not connected`);
      }
      try {
        return await new Promise<ClientChannel>((resolve, reject) => {
          connection.client.forwardOut(sourceHost, sourcePort, destinationHost, destinationPort, (error, channel) => {
            if (error) {
              reject(error);
            } else {
              resolve(channel);
            }
          });
        });
      } catch (error: unknown) {
        if (attempt >= 1) {
          throw error;
        }
        this.options.log(
          `forwardOut to ${destinationHost}:${destinationPort} via ${slot.key} failed (${(error as Error).message}) — reconnecting once`
        );
        this.closeConnection(slot);
      }
    }
  }

  private release(slot: PoolSlot): void {
    slot.refCount = Math.max(0, slot.refCount - 1);
    if (slot.refCount > 0) {
      return;
    }
    if (!slot.connection) {
      if (!slot.connecting) {
        this.slots.delete(slot.key);
      }
      return;
    }
    if (slot.closeOnLastRelease) {
      this.closeConnection(slot);
      return;
    }
    this.clearIdleTimer(slot);
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined;
      this.options.log(`jump host ${slot.key} idle for 5 minutes — closing`);
      this.closeConnection(slot);
    }, JUMP_HOST_IDLE_TIMEOUT_MS);
    // An idle hop must never keep the process alive on its own.
    slot.idleTimer.unref?.();
  }

  /** Deliberate close: detaches first so the 'close' event never counts as an eviction. */
  private closeConnection(slot: PoolSlot): void {
    const connection = slot.connection;
    if (!connection) {
      if (slot.refCount === 0 && !slot.connecting) {
        this.slots.delete(slot.key);
      }
      return;
    }
    slot.connection = undefined;
    connection.client.end();
    if (slot.refCount === 0 && !slot.connecting) {
      this.slots.delete(slot.key);
    }
  }

  private clearIdleTimer(slot: PoolSlot): void {
    if (slot.idleTimer !== undefined) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = undefined;
    }
  }
}
