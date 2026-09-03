import * as vscode from 'vscode';
import { StringDecoder } from 'string_decoder';
import type { Client, ClientChannel } from 'ssh2';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { chainConnect, ChainConnectResult, ChainConnectTarget } from '../ssh/chainConnect';
import { ConnectionCancelledError } from '../ssh/connectErrors';
import { ConnectProviders, KeyboardInteractiveCoordinator } from '../ssh/connectProviders';
import { dialClient } from '../ssh/dialClient';
import { applySshConfig, resolveHostAlias } from '../ssh/SshConfigResolver';

/**
 * Open SSH Terminal (feature 20, Q10/Q29/R7): a `vscode.Pseudoterminal` over an
 * ssh2 `exec` channel with a pty — no ssh binary, the same keychain
 * credentials, prompts, host keys, and pooled jump hosts as every other
 * FileFerry connect.
 *
 * The tab opens immediately with a connecting banner; the dial happens in the
 * background (prompts arrive through the normal providers). The remote side
 * runs `cd -- '<path>' 2>/dev/null; exec "${SHELL:-/bin/sh}" -l` — an exec
 * session, not `shell()` + a written `cd` (rejected in R7): no banner race, no
 * echoed command. Consequences the docs spell out: exec sessions skip MOTD and
 * `~/.ssh/rc`, and the command is POSIX-shell only.
 *
 * The terminal owns a raw target client (`dialClient`) and, for a chained
 * credential, HOLDS its hop leases for the life of the shell — Disconnect's
 * drain therefore never cuts a hop under it (Q25); a hop evicted for another
 * reason (unexpected close, credential change) closes the terminal with
 * "connection to <hop> lost" (Q34). Agent forwarding is not requested (Q24).
 */

export interface SshTerminalOptions {
  serverName: string;
  /** Directory the shell starts in (absolute, POSIX). */
  remotePath: string;
  /** Display route for the banner, e.g. `local → jump@bastion:2222 → deploy@target:22`. */
  route: string;
  /** Loads the target credential with its secret — called from `open()`, after the tab is visible. */
  resolveCredential(): Promise<SshCredentialWithSecret>;
}

export interface SshTerminalDependencies {
  providers: ConnectProviders;
  coordinator: KeyboardInteractiveCoordinator;
  createClient: () => Client;
}

/** R8-13: VS Code may call `open(undefined)`; the pty must still have a size. */
export const DEFAULT_TERMINAL_DIMENSIONS: vscode.TerminalDimensions = { columns: 80, rows: 24 };

export const TERMINAL_TYPE = 'xterm-256color';

/** Single-quotes a value for a POSIX shell: only `'` needs escaping inside single quotes. */
export function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The exec command per R7. `cd` failures are silent so the shell still opens (in `$HOME`). */
export function buildShellCommand(remotePath: string): string {
  return `cd -- ${quoteForPosixShell(remotePath)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`;
}

export class SshTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;

  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closeEmitter.event;

  // Aborted when VS Code closes the tab mid-dial: rejects the connect and
  // dismisses an open keyboard-interactive box (host-key MODALS are not
  // dismissable — accepted, the late verdict lands on a rejected dial).
  private readonly abortController = new AbortController();
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');

  private dimensions: vscode.TerminalDimensions = { ...DEFAULT_TERMINAL_DIMENSIONS };
  private client: Client | undefined;
  private channel: ClientChannel | undefined;
  private chain: ChainConnectResult | undefined;
  private evictSubscription: { dispose(): void } | undefined;
  private exitCode: number | undefined;
  private finished = false;
  // Set after a failure: the tab is held open so the message stays readable
  // (VS Code disposes an extension terminal the instant onDidClose fires);
  // the next keypress delivers this exit code.
  private pendingExitCode: number | undefined;

  constructor(
    private readonly options: SshTerminalOptions,
    private readonly dependencies: SshTerminalDependencies
  ) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) {
      this.dimensions = { columns: initialDimensions.columns, rows: initialDimensions.rows };
    }
    this.writeEmitter.fire(`Connecting to ${this.options.serverName} via ${this.options.route}…\r\n`);
    void this.connect();
  }

  handleInput(data: string): void {
    if (this.pendingExitCode !== undefined) {
      const code = this.pendingExitCode;
      this.pendingExitCode = undefined;
      this.closeEmitter.fire(code);
      return;
    }
    this.channel?.write(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = { columns: dimensions.columns, rows: dimensions.rows };
    // Before the channel exists the size is simply what the exec will ask for.
    this.channel?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
  }

  /** VS Code closed the tab: tear everything down; there is nobody left to report an exit code to. */
  close(): void {
    this.pendingExitCode = undefined;
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.abortController.abort();
    this.teardown();
  }

  private async connect(): Promise<void> {
    const signal = this.abortController.signal;
    try {
      let credential = await this.options.resolveCredential();
      if (credential.useSshConfig) {
        credential = applySshConfig(credential, resolveHostAlias(credential.host));
      }
      const target: ChainConnectTarget = {
        username: credential.username,
        host: credential.host,
        port: credential.port,
      };
      const hopIds = credential.jumpHosts ?? [];

      const client = await dialClient(
        credential,
        {
          interactive: true,
          signal,
          openSock: hopIds.length > 0 ? () => this.openChain(target, hopIds) : undefined,
        },
        this.dependencies
      );
      if (this.finished) {
        client.end();
        this.teardown();
        return;
      }
      this.client = client;
      client.on('close', () => this.finish(1, 'Connection closed.'));
      this.watchRoute();

      const channel = await this.exec(client);
      if (this.finished) {
        channel.end();
        return;
      }
      this.channel = channel;
      this.wireChannel(channel);
    } catch (error: unknown) {
      if (this.finished) {
        return; // the tab is gone — the abort produced this rejection
      }
      const message = error instanceof Error ? error.message : String(error);
      this.finish(1, message);
    }
  }

  /**
   * Leases the hops and opens the forward to the target — called once per
   * dial attempt (the F8 keychain retry needs a fresh channel). The new chain
   * is acquired BEFORE the previous one is released so a drain-marked hop is
   * never closed and re-dialed between attempts.
   */
  private async openChain(target: ChainConnectTarget, hopIds: string[]): Promise<ClientChannel> {
    const support = this.dependencies.providers.jumpHosts;
    if (!support) {
      throw new Error('This connection uses jump hosts, but jump-host support is not initialised in this context');
    }
    const previous = this.chain;
    const chain = await chainConnect(
      target,
      hopIds,
      { interactive: true, signal: this.abortController.signal },
      {
        pool: support.pool,
        resolveHopCredential: (id) => support.resolveCredential(id),
        providers: this.dependencies.providers,
        coordinator: this.dependencies.coordinator,
      }
    );
    previous?.release();
    if (this.finished) {
      chain.release();
      throw new ConnectionCancelledError('the terminal was closed');
    }
    this.chain = chain;
    return chain.sock;
  }

  private exec(client: Client): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      client.exec(
        buildShellCommand(this.options.remotePath),
        { pty: { term: TERMINAL_TYPE, rows: this.dimensions.rows, cols: this.dimensions.columns } },
        (error, channel) => {
          if (error) {
            reject(error);
          } else {
            resolve(channel);
          }
        }
      );
    });
  }

  private wireChannel(channel: ClientChannel): void {
    channel.on('data', (data: Buffer) => {
      this.writeEmitter.fire(this.stdoutDecoder.write(data));
    });
    channel.stderr.on('data', (data: Buffer) => {
      this.writeEmitter.fire(this.stderrDecoder.write(data));
    });
    // Q29: 'exit' carries the status (null when a signal killed the shell),
    // 'close' is when the channel is really gone — report on close.
    channel.on('exit', (code: number | null) => {
      this.exitCode = code ?? undefined;
    });
    channel.on('close', () => {
      this.finish(this.exitCode ?? 1);
    });
  }

  /** Q34: a hop on this terminal's route evicted from the pool means the tunnel is dead. */
  private watchRoute(): void {
    const pool = this.dependencies.providers.jumpHosts?.pool;
    const hopKeys = this.chain?.hopKeys ?? [];
    if (!pool || hopKeys.length === 0) {
      return;
    }
    this.evictSubscription = pool.onDidEvict((key) => {
      if (hopKeys.includes(key)) {
        this.finish(1, `FileFerry: connection to ${key} lost`);
      }
    });
  }

  /**
   * A normal shell exit closes the tab at once (Q29). A failure — dial
   * error, dismissed prompt, dropped connection, evicted hop — keeps the tab
   * open with the message and "Press any key to close": firing onDidClose
   * right away would dispose the terminal before anyone could read it
   * (manual §K finding). The exit code 1 is delivered on the keypress
   * (R8-12, deferred).
   */
  private finish(code: number, message?: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.teardown();
    if (message) {
      this.writeEmitter.fire(`\r\n${message}\r\nPress any key to close this terminal.\r\n`);
      this.pendingExitCode = code;
      return;
    }
    this.closeEmitter.fire(code);
  }

  private teardown(): void {
    this.evictSubscription?.dispose();
    this.evictSubscription = undefined;
    const channel = this.channel;
    this.channel = undefined;
    channel?.end();
    const client = this.client;
    this.client = undefined;
    client?.end();
    const chain = this.chain;
    this.chain = undefined;
    chain?.release();
  }
}
