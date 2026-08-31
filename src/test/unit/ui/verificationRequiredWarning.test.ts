import * as vscode from 'vscode';
import { showVerificationRequiredWarning } from '../../../ui/verificationRequiredWarning';

const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); } };

describe('showVerificationRequiredWarning (18a-1b background fail-fast UX)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows a NON-modal warning naming the server, with a Test Connection button', () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    showVerificationRequiredWarning('Production', 'srv-1');

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Production.*(not yet trusted|verification required)/i),
      'Test Connection'
    );
    // Non-modal: no { modal: true } options object anywhere in the call.
    const args = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
    expect(args.some((a: unknown) => typeof a === 'object' && a !== null && (a as { modal?: boolean }).modal)).toBe(false);
  });

  it('mentions running Test Connection or deploying manually once', () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    showVerificationRequiredWarning('Production', 'srv-1');

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Test Connection.*deploy manually once/i),
      expect.anything()
    );
  });

  it('runs the Test Connection command for the server when the button is clicked', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Test Connection');

    showVerificationRequiredWarning('Production', 'srv-1');
    await flushMicrotasks();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.servers.testConnection', 'srv-1');
  });

  it('does nothing when the warning is dismissed', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    showVerificationRequiredWarning('Production', 'srv-1');
    await flushMicrotasks();

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('appends the caller-supplied detail to the message', () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    showVerificationRequiredWarning('Production', 'srv-1', 'Your edits are saved locally at /tmp/x.php.');

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Your edits are saved locally at /tmp/x.php.'),
      expect.anything()
    );
  });
});
