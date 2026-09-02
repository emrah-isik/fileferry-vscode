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
    }), expect.anything());
    expect(vscode.window.showInputBox).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt: 'PIN: ',
      password: false,
    }), expect.anything());
    expect(result).toEqual(['my-otp-code', 'my-pin']);
  });

  it('returns null when the user dismisses a prompt (cancel)', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

    const result = await showKeyboardInteractivePrompts([
      { prompt: 'Verification code: ', echo: false },
    ]);

    expect(result).toBeNull();
  });

  it('handles empty prompts array', async () => {
    const result = await showKeyboardInteractivePrompts([]);
    expect(result).toEqual([]);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  // 18a-2b (§I wedge fix): an in-flight connect cancelled from outside must
  // dismiss its open prompt — an ignoreFocusOut box would otherwise sit
  // around answering a connect that no longer exists.
  describe('abort signal', () => {
    it('aborting the signal cancels the open input box and resolves null', async () => {
      (vscode.window.showInputBox as jest.Mock).mockImplementation(
        (_options: unknown, token?: { onCancellationRequested: (listener: () => void) => void }) =>
          new Promise(resolve => { token?.onCancellationRequested(() => resolve(undefined)); })
      );
      const controller = new AbortController();

      const pending = showKeyboardInteractivePrompts(
        [{ prompt: 'Verification code: ', echo: false }],
        'SSH login: mfauser@127.0.0.1:2222',
        controller.signal
      );
      controller.abort();

      await expect(pending).resolves.toBeNull();
    });

    it('an already-aborted signal resolves null without showing any box', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await showKeyboardInteractivePrompts(
        [{ prompt: 'Password: ', echo: false }],
        undefined,
        controller.signal
      );

      expect(result).toBeNull();
      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    });
  });

  it('titles every input box with the asking host when a title is given (18a-2a — chains prompt for multiple identities)', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('answer');

    await showKeyboardInteractivePrompts(
      [{ prompt: 'Password: ', echo: false }],
      'SSH login: mfauser@127.0.0.1:2222'
    );

    expect(vscode.window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'SSH login: mfauser@127.0.0.1:2222',
      prompt: 'Password: ',
    }), expect.anything());
  });
});
