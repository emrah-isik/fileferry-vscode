import * as vscode from 'vscode';
import { resetConfirmations } from '../../../commands/resetConfirmations';

// Feature 36 rider: "FileFerry: Reset Upload Confirmations" had shown its toast
// without clearing anything since v0.1.0 (found by manual case A8). The command
// must clear the stored "don't ask again" flags and say how many it cleared.

describe('resetConfirmations command', () => {
  const globalState = {
    get: jest.fn(),
    update: jest.fn(),
    keys: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
  });

  it('clears the stored suppressions and reports the count', async () => {
    globalState.keys.mockReturnValue(['fileferry.confirm.suppress.a', 'fileferry.confirm.suppress.b']);
    await resetConfirmations(globalState as any);
    expect(globalState.update).toHaveBeenCalledTimes(2);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/2 servers/)
    );
  });

  it('uses the singular for one server', async () => {
    globalState.keys.mockReturnValue(['fileferry.confirm.suppress.a']);
    await resetConfirmations(globalState as any);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/1 server\b/)
    );
  });

  it('says so when nothing was suppressed', async () => {
    globalState.keys.mockReturnValue([]);
    await resetConfirmations(globalState as any);
    expect(globalState.update).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/nothing to reset|no server/i)
    );
  });
});
