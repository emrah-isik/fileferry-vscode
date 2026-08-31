import * as vscode from 'vscode';

/**
 * Shows one input box per prompt. Resolves `null` as soon as the user
 * dismisses one — a cancelled challenge must abort the connect, not be
 * answered with empty strings.
 */
export async function showKeyboardInteractivePrompts(
  prompts: Array<{ prompt: string; echo: boolean }>
): Promise<string[] | null> {
  const responses: string[] = [];

  for (const p of prompts) {
    const value = await vscode.window.showInputBox({
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
