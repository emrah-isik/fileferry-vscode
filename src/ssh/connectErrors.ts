/**
 * Typed failures for non-interactive connects (`interactive: false`).
 *
 * Background triggers (upload-on-save, the file watcher, the Remote Files tree
 * render, autosave-driven remote-edit saves) must never raise a prompt, but
 * they still verify. When verification would need the user, the connect fails
 * fast with one of these errors so the caller can show the non-modal
 * "verification required" warning (or a placeholder row) instead of a generic
 * connection error. This module must stay free of `vscode` imports — it is
 * thrown from `SftpService` and inspected by UI callers.
 */

/** Base class: the connect needed the user and was not allowed to ask. */
export class InteractionRequiredError extends Error {}

/** The host key is not in the trust store (unknown) or does not match it (changed). */
export class HostNotTrustedError extends InteractionRequiredError {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly status: 'unknown' | 'changed'
  ) {
    super(
      status === 'changed'
        ? `The host key for ${host}:${port} has changed — verify it before background uploads can continue`
        : `${host}:${port} is not yet a trusted host — verify it once (e.g. Test Connection) to enable background uploads`
    );
    this.name = 'HostNotTrustedError';
  }
}

/** Authenticating needs interactive prompts (keyboard-interactive) that a background connect cannot show. */
export class VerificationRequiredError extends InteractionRequiredError {
  constructor(readonly host: string, readonly port: number) {
    super(
      `Authenticating to ${host}:${port} requires answering prompts, which a background connection cannot show`
    );
    this.name = 'VerificationRequiredError';
  }
}
