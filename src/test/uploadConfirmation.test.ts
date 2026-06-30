import * as vscode from 'vscode';
import { UploadConfirmation } from '../uploadConfirmation';

const mockGlobalState = {
  get: jest.fn(),
  update: jest.fn(),
};

const mockShowMessage = jest.fn();

describe('UploadConfirmation', () => {
  let confirmation: UploadConfirmation;

  beforeEach(() => {
    jest.clearAllMocks();
    confirmation = new UploadConfirmation(mockGlobalState as any, mockShowMessage);
  });

  it('returns true without prompting when suppressed for this server', async () => {
    mockGlobalState.get.mockReturnValue(true);
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(true);
    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('shows correct message with file count', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue('Upload');
    await confirmation.confirm('prod', 5);
    expect(mockShowMessage).toHaveBeenCalledWith(
      'Upload 5 files to "prod"?',
      'Upload',
      "Upload, don't ask again",
      'Cancel'
    );
  });

  it('shows server name instead of id when serverName is provided', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue('Upload');
    await confirmation.confirm('b447ea4e-6693-4a46-8e3c-e708c4bdad98', 2, 'Production');
    expect(mockShowMessage).toHaveBeenCalledWith(
      'Upload 2 files to "Production"?',
      expect.any(String),
      expect.any(String),
      expect.any(String)
    );
  });

  it('falls back to server id in message when serverName is not provided', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue('Upload');
    await confirmation.confirm('prod', 2);
    expect(mockShowMessage).toHaveBeenCalledWith(
      'Upload 2 files to "prod"?',
      expect.any(String),
      expect.any(String),
      expect.any(String)
    );
  });

  it('shows singular "1 file" when count is 1', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue('Upload');
    await confirmation.confirm('staging', 1);
    expect(mockShowMessage).toHaveBeenCalledWith(
      'Upload 1 file to "staging"?',
      expect.any(String),
      expect.any(String),
      expect.any(String)
    );
  });

  it('returns true when user clicks Upload', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue('Upload');
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(true);
    expect(mockGlobalState.update).not.toHaveBeenCalled();
  });

  it('returns true and suppresses future prompts when user clicks dont ask again', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue("Upload, don't ask again");
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(true);
    expect(mockGlobalState.update).toHaveBeenCalledWith(
      'fileferry.confirm.suppress.prod', true
    );
  });

  it('returns false when user clicks Cancel', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue('Cancel');
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(false);
  });

  it('returns false when user dismisses dialog (undefined)', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue(undefined);
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(false);
  });

  it('resets suppression for all given server ids', async () => {
    await confirmation.resetAll(['prod', 'staging']);
    expect(mockGlobalState.update).toHaveBeenCalledWith('fileferry.confirm.suppress.prod', false);
    expect(mockGlobalState.update).toHaveBeenCalledWith('fileferry.confirm.suppress.staging', false);
  });
});

describe('UploadConfirmation.confirmWithDeletions', () => {
  let confirmation: UploadConfirmation;

  beforeEach(() => {
    jest.clearAllMocks();
    confirmation = new UploadConfirmation(mockGlobalState as any, mockShowMessage);
  });

  it('always shows dialog even when suppressed (deletions are irreversible)', async () => {
    mockGlobalState.get.mockReturnValue(true); // suppressed
    mockShowMessage.mockResolvedValue('Proceed');
    await confirmation.confirmWithDeletions('Production', 2, 1);
    expect(mockShowMessage).toHaveBeenCalled();
  });

  it('shows upload and delete counts in the message', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue('Proceed');
    await confirmation.confirmWithDeletions('Production', 3, 2);
    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('3'),
      expect.any(String),
      expect.any(String)
    );
    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('2'),
      expect.any(String),
      expect.any(String)
    );
    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('Production'),
      expect.any(String),
      expect.any(String)
    );
  });

  it('does not offer "don\'t ask again" when deletions are present', async () => {
    mockGlobalState.get.mockReturnValue(false);
    mockShowMessage.mockResolvedValue('Proceed');
    await confirmation.confirmWithDeletions('Production', 1, 1);
    const call = mockShowMessage.mock.calls[0];
    const options = call.slice(1); // everything after the message string
    expect(options.join(' ')).not.toContain("don't ask again");
  });

  it('returns true when user confirms', async () => {
    mockShowMessage.mockResolvedValue('Proceed');
    const result = await confirmation.confirmWithDeletions('Production', 1, 1);
    expect(result).toBe(true);
  });

  it('returns false when user cancels', async () => {
    mockShowMessage.mockResolvedValue('Cancel');
    const result = await confirmation.confirmWithDeletions('Production', 1, 1);
    expect(result).toBe(false);
  });

  it('returns false when user dismisses (undefined)', async () => {
    mockShowMessage.mockResolvedValue(undefined);
    const result = await confirmation.confirmWithDeletions('Production', 0, 1);
    expect(result).toBe(false);
  });

  it('does not update globalState (no suppression for deletions)', async () => {
    mockShowMessage.mockResolvedValue('Proceed');
    await confirmation.confirmWithDeletions('Production', 1, 2);
    expect(mockGlobalState.update).not.toHaveBeenCalled();
  });
});

describe('UploadConfirmation.confirmSyncDeletions', () => {
  let confirmation: UploadConfirmation;
  const mockShowModalWarning = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    // The destructive delete confirm goes through the injected modal-warning
    // channel, NOT the dismissable info toast used for ordinary confirms.
    confirmation = new UploadConfirmation(mockGlobalState as any, mockShowMessage, mockShowModalWarning);
  });

  it('names the upload and delete counts and warns deletes are irreversible', async () => {
    mockShowModalWarning.mockResolvedValue('Sync and Delete');
    await confirmation.confirmSyncDeletions('Production', 4, 3);
    const [message] = mockShowModalWarning.mock.calls[0];
    expect(message).toContain('Production');
    expect(message).toContain('4');
    expect(message).toContain('3');
    expect(message.toLowerCase()).toContain('cannot be recovered');
    // Uses the modal channel, never the plain info toast.
    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('returns true only when the user picks the delete action', async () => {
    mockShowModalWarning.mockResolvedValue('Sync and Delete');
    expect(await confirmation.confirmSyncDeletions('Production', 1, 1)).toBe(true);
  });

  it('returns false when the user cancels or dismisses', async () => {
    mockShowModalWarning.mockResolvedValue('Cancel');
    expect(await confirmation.confirmSyncDeletions('Production', 1, 1)).toBe(false);
    mockShowModalWarning.mockResolvedValue(undefined);
    expect(await confirmation.confirmSyncDeletions('Production', 1, 1)).toBe(false);
  });

  it('never suppresses and never offers "don\'t ask again"', async () => {
    mockGlobalState.get.mockReturnValue(true); // even if a suppress flag exists
    mockShowModalWarning.mockResolvedValue('Sync and Delete');
    await confirmation.confirmSyncDeletions('Production', 1, 1);
    expect(mockShowModalWarning).toHaveBeenCalled();
    const options = mockShowModalWarning.mock.calls[0].slice(1);
    expect(options.join(' ')).not.toContain("don't ask again");
    expect(mockGlobalState.update).not.toHaveBeenCalled();
  });

  it('defaults to a real modal warning dialog (not a dismissable toast)', async () => {
    const realConfirmation = new UploadConfirmation(mockGlobalState as any, mockShowMessage);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Sync and Delete');

    const confirmed = await realConfirmation.confirmSyncDeletions('Production', 2, 1);

    expect(confirmed).toBe(true);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot be recovered'),
      { modal: true },
      'Sync and Delete'
    );
  });
});

describe('UploadConfirmation — deploy hooks visibility', () => {
  let confirmation: UploadConfirmation;
  const mockShowModalWarning = jest.fn();

  const hooks = {
    preDeploy: [{ command: 'npm run build', location: 'local' as const }],
    postDeploy: [{ command: 'systemctl reload nginx', location: 'remote' as const }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    confirmation = new UploadConfirmation(mockGlobalState as any, mockShowMessage, mockShowModalWarning);
  });

  describe('confirm', () => {
    it('lists each hook command with its phase and location', async () => {
      mockGlobalState.get.mockReturnValue(false);
      mockShowMessage.mockResolvedValue('Upload');
      await confirmation.confirm('prod', 3, 'Production', hooks);
      const [message] = mockShowMessage.mock.calls[0];
      expect(message).toContain('npm run build');
      expect(message).toContain('systemctl reload nginx');
      expect(message).toContain('pre');
      expect(message).toContain('post');
      expect(message).toContain('local');
      expect(message).toContain('remote');
    });

    it('always shows the dialog when hooks are present, even if suppressed', async () => {
      mockGlobalState.get.mockReturnValue(true); // suppressed
      mockShowMessage.mockResolvedValue('Upload');
      const result = await confirmation.confirm('prod', 3, 'Production', hooks);
      expect(mockShowMessage).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('does not offer "don\'t ask again" when hooks are present', async () => {
      mockGlobalState.get.mockReturnValue(false);
      mockShowMessage.mockResolvedValue('Upload');
      await confirmation.confirm('prod', 3, 'Production', hooks);
      const options = mockShowMessage.mock.calls[0].slice(1);
      expect(options.join(' ')).not.toContain("don't ask again");
      expect(mockGlobalState.update).not.toHaveBeenCalled();
    });

    it('returns false when the user cancels a hooked deploy', async () => {
      mockGlobalState.get.mockReturnValue(false);
      mockShowMessage.mockResolvedValue('Cancel');
      expect(await confirmation.confirm('prod', 3, 'Production', hooks)).toBe(false);
    });

    it('keeps the normal suppressible flow when no hooks are given', async () => {
      mockGlobalState.get.mockReturnValue(true); // suppressed
      const result = await confirmation.confirm('prod', 3, 'Production');
      expect(result).toBe(true);
      expect(mockShowMessage).not.toHaveBeenCalled();
    });

    it('keeps the normal flow when hooks object has empty arrays', async () => {
      mockGlobalState.get.mockReturnValue(true); // suppressed
      const result = await confirmation.confirm('prod', 3, 'Production', { preDeploy: [], postDeploy: [] });
      expect(result).toBe(true);
      expect(mockShowMessage).not.toHaveBeenCalled();
    });
  });

  describe('confirmWithDeletions', () => {
    it('lists hook commands alongside the upload/delete summary', async () => {
      mockShowMessage.mockResolvedValue('Proceed');
      await confirmation.confirmWithDeletions('Production', 2, 1, hooks);
      const [message] = mockShowMessage.mock.calls[0];
      expect(message).toContain('npm run build');
      expect(message).toContain('systemctl reload nginx');
    });
  });

  describe('confirmSyncDeletions', () => {
    it('lists hook commands in the modal delete warning', async () => {
      mockShowModalWarning.mockResolvedValue('Sync and Delete');
      await confirmation.confirmSyncDeletions('Production', 4, 3, hooks);
      const [message] = mockShowModalWarning.mock.calls[0];
      expect(message).toContain('npm run build');
      expect(message).toContain('systemctl reload nginx');
    });
  });

  describe('confirmHooks (multi-server, no per-file dialog)', () => {
    it('shows a modal listing hooks grouped by server and returns true on proceed', async () => {
      mockShowModalWarning.mockResolvedValue('Proceed');
      const result = await confirmation.confirmHooks([
        { serverName: 'Staging', hooks: { preDeploy: [{ command: 'npm run build', location: 'local' }] } },
        { serverName: 'Production', hooks: { postDeploy: [{ command: 'reload nginx', location: 'remote' }] } },
      ]);
      expect(result).toBe(true);
      const [message] = mockShowModalWarning.mock.calls[0];
      expect(message).toContain('Staging');
      expect(message).toContain('npm run build');
      expect(message).toContain('Production');
      expect(message).toContain('reload nginx');
    });

    it('returns true without prompting when no server has hooks', async () => {
      const result = await confirmation.confirmHooks([
        { serverName: 'Staging', hooks: undefined },
        { serverName: 'Production', hooks: { preDeploy: [], postDeploy: [] } },
      ]);
      expect(result).toBe(true);
      expect(mockShowModalWarning).not.toHaveBeenCalled();
    });

    it('returns false when the user cancels', async () => {
      mockShowModalWarning.mockResolvedValue(undefined);
      const result = await confirmation.confirmHooks([
        { serverName: 'Production', hooks: { postDeploy: [{ command: 'reload', location: 'remote' }] } },
      ]);
      expect(result).toBe(false);
    });
  });
});
