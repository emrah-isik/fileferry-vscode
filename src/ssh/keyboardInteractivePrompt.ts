import * as vscode from 'vscode';

/**
 * Shows one input box per prompt. Resolves `null` as soon as the user
 * dismisses one — a cancelled challenge must abort the connect, not be
 * answered with empty strings.
 *
 * `title` names WHO is asking (e.g. `SSH login: mfauser@127.0.0.1:2222`).
 * Through a jump-host chain several identities prompt in one connect — a
 * bare "Password:" would be unanswerable (18a-2a).
 */
export async function showKeyboardInteractivePrompts(
  prompts: Array<{ prompt: string; echo: boolean }>,
  title?: string,
  signal?: AbortSignal
): Promise<string[] | null> {
  const responses: string[] = [];

  for (const p of prompts) {
    // A cancelled connect (18a-2b) dismisses the open box via the signal —
    // ignoreFocusOut keeps it alive through focus loss, so nothing else
    // would ever close it.
    if (signal?.aborted) {
      return null;
    }
    const cancellation = new vscode.CancellationTokenSource();
    const onAbort = (): void => cancellation.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    let value: string | undefined;
    try {
      value = await vscode.window.showInputBox({
        ...(title ? { title } : {}),
        prompt: p.prompt,
        password: !p.echo,
        ignoreFocusOut: true,
      }, cancellation.token);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      cancellation.dispose();
    }
    if (value === undefined) {
      return null;
    }
    responses.push(value);
  }

  return responses;
}
