import { HostKeyManager } from './HostKeyManager';
import { showHostKeyPrompt } from './hostKeyPrompt';
import { showKeyboardInteractivePrompts } from './keyboardInteractivePrompt';
import {
  ConnectTarget,
  HostKeyProvider,
  KeyboardInteractiveProvider,
  KeyboardInteractiveRequest,
  PromptContext,
  StoredHostKeyStatus,
} from './connectProviders';

/** Answers keyboard-interactive challenges with VS Code input boxes. */
export class VscodeKeyboardInteractiveProvider implements KeyboardInteractiveProvider {
  prompt(request: KeyboardInteractiveRequest, context: PromptContext): Promise<string[] | null> {
    context.promptOpened();
    return showKeyboardInteractivePrompts(request.prompts);
  }
}

/**
 * Trust-on-first-use host-key verdicts: trusted entries pass silently, unknown
 * and changed keys go through the modal prompt, and an accepted key is
 * persisted before the verdict is delivered. Callback form only — see
 * `HostKeyProvider`.
 */
export class VscodeHostKeyProvider implements HostKeyProvider {
  constructor(
    private readonly hostKeyManager: HostKeyManager,
    private readonly log: (line: string) => void
  ) {}

  checkStored(target: Pick<ConnectTarget, 'host' | 'port'>, key: Buffer): Promise<StoredHostKeyStatus> {
    return this.hostKeyManager.check(target.host, target.port, key.toString('base64'));
  }

  verify(
    target: Pick<ConnectTarget, 'host' | 'port'>,
    key: Buffer,
    context: PromptContext,
    verdict: (permitted: boolean) => void
  ): void {
    this.decide(target, key, context).then(
      (permitted) => verdict(permitted),
      (error: unknown) => {
        // Fail closed: an error while checking or prompting is never a "yes".
        const message = error instanceof Error ? error.message : String(error);
        this.log(`host key verification for ${target.host}:${target.port} failed: ${message}`);
        verdict(false);
      }
    );
  }

  private async decide(target: Pick<ConnectTarget, 'host' | 'port'>, key: Buffer, context: PromptContext): Promise<boolean> {
    const keyBase64 = key.toString('base64');
    const status = await this.hostKeyManager.check(target.host, target.port, keyBase64);
    if (status === 'trusted') {
      return true;
    }

    context.promptOpened();
    const fingerprint = this.hostKeyManager.getFingerprint(keyBase64);
    this.log(`host key for ${target.host}:${target.port} is ${status} (${fingerprint}) — asking`);
    const accepted = await showHostKeyPrompt(target.host, target.port, fingerprint, status);
    if (accepted) {
      await this.hostKeyManager.trust(target.host, target.port, keyBase64);
    }
    return accepted;
  }
}
