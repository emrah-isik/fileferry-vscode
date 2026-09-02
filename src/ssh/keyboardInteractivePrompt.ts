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
  title?: string
): Promise<string[] | null> {
  const responses: string[] = [];

  for (const p of prompts) {
    const value = await vscode.window.showInputBox({
      ...(title ? { title } : {}),
      prompt: p.prompt,
      password: !p.echo,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return null;
    }
    responses.push(value);
  }

  return responses;
}
