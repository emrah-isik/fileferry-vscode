import * as vscode from 'vscode';
import { showKeyboardInteractivePrompts } from '../../../ssh/keyboardInteractivePrompt';

describe('showKeyboardInteractivePrompts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows an input box for each prompt and returns responses', async () => {
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('my-otp-code')
      .mockResolvedValueOnce('my-pin');

    const result = await showKeyboardInteractivePrompts([
      { prompt: 'Verification code: ', echo: false },
      { prompt: 'PIN: ', echo: true },
    ]);

    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
    expect(vscode.window.showInputBox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prompt: 'Verification code: ',
      password: true,
    }));
    expect(vscode.window.showInputBox).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt: 'PIN: ',
      password: false,
    }));
    expect(result).toEqual(['my-otp-code', 'my-pin']);
  });

  it('returns empty strings when user dismisses prompt', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

    const result = await showKeyboardInteractivePrompts([
      { prompt: 'Verification code: ', echo: false },
    ]);

    expect(result).toEqual(['']);
  });

  it('handles empty prompts array', async () => {
    const result = await showKeyboardInteractivePrompts([]);
    expect(result).toEqual([]);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });
});
