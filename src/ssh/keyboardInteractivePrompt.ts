import * as vscode from 'vscode';

export async function showKeyboardInteractivePrompts(
  prompts: Array<{ prompt: string; echo: boolean }>
): Promise<string[]> {
  const responses: string[] = [];

  for (const p of prompts) {
    const value = await vscode.window.showInputBox({
      prompt: p.prompt,
      password: !p.echo,
      ignoreFocusOut: true,
    });
    responses.push(value ?? '');
  }

  return responses;
}
