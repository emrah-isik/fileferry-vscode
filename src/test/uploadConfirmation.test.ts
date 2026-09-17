import * as vscode from 'vscode';
import { ConfirmationChoice, UploadConfirmation } from '../uploadConfirmation';

const mockGlobalState = {
  get: jest.fn(),
  update: jest.fn(),
};

// Feature 36: the confirmation is a QuickPick (keyboard-first), driven through an
// injected `showPick(title, items)` so the class is testable without VS Code.
const mockShowPick = jest.fn();
const mockOutput = { appendLine: jest.fn(), show: jest.fn() };

// Resolves the pick with the item carrying the given label (what Enter or a click
// on that row does), or with undefined for Escape / focus loss.
function pickLabel(label: string | undefined): void {
  mockShowPick.mockImplementation(async (_title: string, items: ConfirmationChoice[]) =>
    label === undefined ? undefined : items.find(item => item.label === label)
  );
}

function shownTitle(): string {
  return mockShowPick.mock.calls[0][0];
}

function shownLabels(): string[] {
  return (mockShowPick.mock.calls[0][1] as ConfirmationChoice[]).map(item => item.label);
}

function shownItem(label: string): ConfirmationChoice {
  const item = (mockShowPick.mock.calls[0][1] as ConfirmationChoice[]).find(candidate => candidate.label === label);
  if (!item) {
    throw new Error(`no item labelled "${label}"`);
  }
  return item;
}

describe('UploadConfirmation', () => {
  let confirmation: UploadConfirmation;

  beforeEach(() => {
    jest.clearAllMocks();
    confirmation = new UploadConfirmation(mockGlobalState as any, mockOutput as any, mockShowPick);
  });

  it('returns true without prompting when suppressed for this server', async () => {
    mockGlobalState.get.mockReturnValue(true);
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(true);
    expect(mockShowPick).not.toHaveBeenCalled();
  });

  it('asks the question as the pick title, with the file count', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Upload');
    await confirmation.confirm('prod', 5);
    expect(shownTitle()).toBe('Upload 5 files to "prod"?');
  });

  it('offers Upload, "don\'t ask again", and Cancel, in that order', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Upload');
    await confirmation.confirm('prod', 5);
    expect(shownLabels()).toEqual(['Upload', "Upload, don't ask again", 'Cancel']);
  });

  it('shows server name instead of id when serverName is provided', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Upload');
    await confirmation.confirm('b447ea4e-6693-4a46-8e3c-e708c4bdad98', 2, 'Production');
    expect(shownTitle()).toBe('Upload 2 files to "Production"?');
  });

  it('falls back to server id in the title when serverName is not provided', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Upload');
    await confirmation.confirm('prod', 2);
    expect(shownTitle()).toBe('Upload 2 files to "prod"?');
  });

  it('shows singular "1 file" when count is 1', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Upload');
    await confirmation.confirm('staging', 1);
    expect(shownTitle()).toBe('Upload 1 file to "staging"?');
  });

  it('explains the "don\'t ask again" row: which server, and how to undo it', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Upload');
    await confirmation.confirm('prod', 3, 'Production');
    const detail = shownItem("Upload, don't ask again").detail ?? '';
    expect(detail).toContain('Production');
    expect(detail).toContain('Reset Upload Confirmations');
  });

  it('returns true when the user picks Upload', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Upload');
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(true);
    expect(mockGlobalState.update).not.toHaveBeenCalled();
  });

  it('returns true and suppresses future prompts when the user picks "don\'t ask again"', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel("Upload, don't ask again");
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(true);
    expect(mockGlobalState.update).toHaveBeenCalledWith('fileferry.confirm.suppress.prod', true);
  });

  it('returns false when the user picks Cancel', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Cancel');
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(false);
  });

  it('returns false when the pick is dismissed (Escape or focus loss)', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel(undefined);
    const result = await confirmation.confirm('prod', 3);
    expect(result).toBe(false);
  });

  it('resets suppression for all given server ids', async () => {
    await confirmation.resetAll(['prod', 'staging']);
    expect(mockGlobalState.update).toHaveBeenCalledWith('fileferry.confirm.suppress.prod', false);
    expect(mockGlobalState.update).toHaveBeenCalledWith('fileferry.confirm.suppress.staging', false);
  });

  it('defaults to a real QuickPick with the question as its title', async () => {
    mockGlobalState.get.mockReturnValue(false);
    const realConfirmation = new UploadConfirmation(mockGlobalState as any, mockOutput as any);
    (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: ConfirmationChoice[]) =>
      items.find(item => item.label === 'Upload')
    );

    const confirmed = await realConfirmation.confirm('prod', 2, 'Production');

    expect(confirmed).toBe(true);
    const [items, options] = (vscode.window.showQuickPick as jest.Mock).mock.calls[0];
    expect(items.map((item: ConfirmationChoice) => item.label)).toEqual(['Upload', "Upload, don't ask again", 'Cancel']);
    expect(options).toEqual(expect.objectContaining({ title: 'Upload 2 files to "Production"?', ignoreFocusOut: false }));
  });
});

describe('UploadConfirmation.confirmWithDeletions', () => {
  let confirmation: UploadConfirmation;

  beforeEach(() => {
    jest.clearAllMocks();
    confirmation = new UploadConfirmation(mockGlobalState as any, mockOutput as any, mockShowPick);
  });

  it('always shows the pick even when suppressed (deletions are irreversible)', async () => {
    mockGlobalState.get.mockReturnValue(true); // suppressed
    pickLabel('Proceed');
    await confirmation.confirmWithDeletions('Production', 2, 1);
    expect(mockShowPick).toHaveBeenCalled();
  });

  it('names the server and the upload and delete counts in the title', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Proceed');
    await confirmation.confirmWithDeletions('Production', 3, 2);
    expect(shownTitle()).toBe('Deploy to "Production": upload 3 files and delete 2 files?');
  });

  it('offers only Proceed and Cancel (no "don\'t ask again")', async () => {
    mockGlobalState.get.mockReturnValue(false);
    pickLabel('Proceed');
    await confirmation.confirmWithDeletions('Production', 1, 1);
    expect(shownLabels()).toEqual(['Proceed', 'Cancel']);
  });

  it('returns true when the user proceeds', async () => {
    pickLabel('Proceed');
    const result = await confirmation.confirmWithDeletions('Production', 1, 1);
    expect(result).toBe(true);
  });

  it('returns false when the user cancels', async () => {
    pickLabel('Cancel');
    const result = await confirmation.confirmWithDeletions('Production', 1, 1);
    expect(result).toBe(false);
  });

  it('returns false when the pick is dismissed', async () => {
    pickLabel(undefined);
    const result = await confirmation.confirmWithDeletions('Production', 0, 1);
    expect(result).toBe(false);
  });

  it('does not update globalState (no suppression for deletions)', async () => {
    pickLabel('Proceed');
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
    // channel, NOT the dismissable QuickPick used for ordinary confirms.
    confirmation = new UploadConfirmation(mockGlobalState as any, mockOutput as any, mockShowPick, mockShowModalWarning);
  });

  it('names the upload and delete counts and warns deletes are irreversible', async () => {
    mockShowModalWarning.mockResolvedValue('Sync and Delete');
    await confirmation.confirmSyncDeletions('Production', 4, 3);
    const [message] = mockShowModalWarning.mock.calls[0];
    expect(message).toContain('Production');
    expect(message).toContain('4');
    expect(message).toContain('3');
    expect(message.toLowerCase()).toContain('cannot be recovered');
    // Uses the modal channel, never the pick.
    expect(mockShowPick).not.toHaveBeenCalled();
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

  it('defaults to a real modal warning dialog (not a dismissable pick)', async () => {
    const realConfirmation = new UploadConfirmation(mockGlobalState as any, mockOutput as any, mockShowPick);
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

describe('UploadConfirmation, deploy hooks visibility', () => {
  let confirmation: UploadConfirmation;
  const mockShowModalWarning = jest.fn();

  const hooks = {
    preDeploy: [{ command: 'npm run build', location: 'local' as const }],
    postDeploy: [{ command: 'systemctl reload nginx', location: 'remote' as const }],
  };

  // All lines written to the (mock) output channel, joined for assertions.
  const outputText = () => mockOutput.appendLine.mock.calls.map(call => call[0]).join('\n');

  beforeEach(() => {
    jest.clearAllMocks();
    confirmation = new UploadConfirmation(
      mockGlobalState as any, mockOutput as any, mockShowPick, mockShowModalWarning
    );
  });

  describe('confirm', () => {
    it('writes each hook command (phase + location) to the output channel and reveals it', async () => {
      mockGlobalState.get.mockReturnValue(false);
      pickLabel('Upload');
      await confirmation.confirm('prod', 3, 'Production', hooks);
      const text = outputText();
      expect(text).toContain('npm run build');
      expect(text).toContain('systemctl reload nginx');
      expect(text).toContain('pre');
      expect(text).toContain('post');
      expect(text).toContain('local');
      expect(text).toContain('remote');
      expect(mockOutput.show).toHaveBeenCalledWith(true);
    });

    it('names the hook count on the Upload row and points at the output (not a modal)', async () => {
      mockGlobalState.get.mockReturnValue(false);
      pickLabel('Upload');
      await confirmation.confirm('prod', 3, 'Production', hooks);
      expect(shownTitle()).toBe('Upload 3 files to "Production"?');
      const detail = shownItem('Upload').detail ?? '';
      expect(detail).toContain('2 hooks');
      expect(detail).toMatch(/FileFerry output/i);
      expect(mockShowModalWarning).not.toHaveBeenCalled();
    });

    it('always shows the pick when hooks are present, even if suppressed', async () => {
      mockGlobalState.get.mockReturnValue(true); // suppressed
      pickLabel('Upload');
      const result = await confirmation.confirm('prod', 3, 'Production', hooks);
      expect(mockShowPick).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('does not offer "don\'t ask again" when hooks are present', async () => {
      mockGlobalState.get.mockReturnValue(false);
      pickLabel('Upload');
      await confirmation.confirm('prod', 3, 'Production', hooks);
      expect(shownLabels()).toEqual(['Upload', 'Cancel']);
      expect(mockGlobalState.update).not.toHaveBeenCalled();
    });

    it('returns false when the user dismisses a hooked deploy', async () => {
      mockGlobalState.get.mockReturnValue(false);
      pickLabel(undefined);
      expect(await confirmation.confirm('prod', 3, 'Production', hooks)).toBe(false);
    });

    it('keeps the normal suppressible flow when no hooks are given', async () => {
      mockGlobalState.get.mockReturnValue(true); // suppressed
      const result = await confirmation.confirm('prod', 3, 'Production');
      expect(result).toBe(true);
      expect(mockShowPick).not.toHaveBeenCalled();
      expect(mockOutput.appendLine).not.toHaveBeenCalled();
    });

    it('keeps the normal flow when hooks object has empty arrays', async () => {
      mockGlobalState.get.mockReturnValue(true); // suppressed
      const result = await confirmation.confirm('prod', 3, 'Production', { preDeploy: [], postDeploy: [] });
      expect(result).toBe(true);
      expect(mockShowPick).not.toHaveBeenCalled();
    });
  });

  describe('confirmWithDeletions', () => {
    it('writes hook commands to the output and names the hook count on the Proceed row', async () => {
      pickLabel('Proceed');
      await confirmation.confirmWithDeletions('Production', 2, 1, hooks);
      expect(shownTitle()).toContain('Production');
      const detail = shownItem('Proceed').detail ?? '';
      expect(detail).toContain('2 hooks');
      expect(detail).toMatch(/FileFerry output/i);
      expect(outputText()).toContain('npm run build');
      expect(outputText()).toContain('systemctl reload nginx');
    });
  });

  describe('confirmSyncDeletions', () => {
    it('keeps the destructive modal warning and writes the hook list to the output', async () => {
      mockShowModalWarning.mockResolvedValue('Sync and Delete');
      await confirmation.confirmSyncDeletions('Production', 4, 3, hooks);
      const [message] = mockShowModalWarning.mock.calls[0];
      expect(message).toContain('cannot be recovered');
      expect(message).toMatch(/hook/i); // notes hooks will also run
      expect(outputText()).toContain('npm run build');
      expect(outputText()).toContain('systemctl reload nginx');
    });
  });

  describe('confirmHooks (multi-server, no per-file dialog)', () => {
    it('lists hooks grouped by server in the output and returns true on proceed', async () => {
      pickLabel('Proceed');
      const result = await confirmation.confirmHooks([
        { serverName: 'Staging', hooks: { preDeploy: [{ command: 'npm run build', location: 'local' }] } },
        { serverName: 'Production', hooks: { postDeploy: [{ command: 'reload nginx', location: 'remote' }] } },
      ]);
      expect(result).toBe(true);
      const text = outputText();
      expect(text).toContain('Staging');
      expect(text).toContain('npm run build');
      expect(text).toContain('Production');
      expect(text).toContain('reload nginx');
      expect(shownTitle()).toContain('2 server(s)');
      expect(shownLabels()).toEqual(['Proceed', 'Cancel']);
    });

    it('returns true without prompting when no server has hooks', async () => {
      const result = await confirmation.confirmHooks([
        { serverName: 'Staging', hooks: undefined },
        { serverName: 'Production', hooks: { preDeploy: [], postDeploy: [] } },
      ]);
      expect(result).toBe(true);
      expect(mockShowPick).not.toHaveBeenCalled();
      expect(mockOutput.appendLine).not.toHaveBeenCalled();
    });

    it('returns false when the user cancels', async () => {
      pickLabel(undefined);
      const result = await confirmation.confirmHooks([
        { serverName: 'Production', hooks: { postDeploy: [{ command: 'reload', location: 'remote' }] } },
      ]);
      expect(result).toBe(false);
    });
  });
});

describe('UploadConfirmation.resetAll without arguments (the reset command)', () => {
  // The command cannot know every server that ever had "don't ask again"
  // pressed (servers get deleted, projects change), so the sweep reads the
  // stored keys instead of a server list.
  const sweepState = {
    get: jest.fn(),
    update: jest.fn(),
    keys: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears every stored suppression key and returns how many it cleared', async () => {
    sweepState.keys.mockReturnValue([
      'fileferry.confirm.suppress.prod',
      'fileferry.confirm.suppress.staging',
      'fileferry.somethingElse',
    ]);
    const confirmation = new UploadConfirmation(sweepState as any, mockOutput as any, mockShowPick);
    const cleared = await confirmation.resetAll();
    expect(cleared).toBe(2);
    expect(sweepState.update).toHaveBeenCalledWith('fileferry.confirm.suppress.prod', false);
    expect(sweepState.update).toHaveBeenCalledWith('fileferry.confirm.suppress.staging', false);
    expect(sweepState.update).not.toHaveBeenCalledWith('fileferry.somethingElse', expect.anything());
  });

  it('returns 0 and touches nothing when no suppression is stored', async () => {
    sweepState.keys.mockReturnValue(['fileferry.somethingElse']);
    const confirmation = new UploadConfirmation(sweepState as any, mockOutput as any, mockShowPick);
    expect(await confirmation.resetAll()).toBe(0);
    expect(sweepState.update).not.toHaveBeenCalled();
  });

  it('still accepts an explicit server list and reports that count', async () => {
    const confirmation = new UploadConfirmation(sweepState as any, mockOutput as any, mockShowPick);
    expect(await confirmation.resetAll(['prod', 'staging'])).toBe(2);
    expect(sweepState.keys).not.toHaveBeenCalled();
  });
});

describe('UploadConfirmation.confirmOverwriteNewer (file date guard, 36b)', () => {
  let confirmation: UploadConfirmation;

  beforeEach(() => {
    jest.clearAllMocks();
    confirmation = new UploadConfirmation(mockGlobalState as any, mockOutput as any, mockShowPick);
  });

  it('asks with the count and server in the title and lists the files on the Overwrite row', async () => {
    pickLabel('Overwrite');
    await confirmation.confirmOverwriteNewer('Production', ['app.php', 'config.php']);
    expect(shownTitle()).toBe('2 files are newer on "Production". Overwrite them?');
    expect(shownLabels()).toEqual(['Overwrite', 'Cancel']);
    const detail = shownItem('Overwrite').detail ?? '';
    expect(detail).toContain('app.php');
    expect(detail).toContain('config.php');
  });

  it('uses the singular for one file and "the remote" when no server name is given', async () => {
    pickLabel('Overwrite');
    await confirmation.confirmOverwriteNewer(undefined, ['app.php']);
    expect(shownTitle()).toBe('1 file is newer on the remote. Overwrite it?');
  });

  it('returns true only for Overwrite; Cancel and dismissal return false', async () => {
    pickLabel('Overwrite');
    expect(await confirmation.confirmOverwriteNewer('Production', ['a.php'])).toBe(true);
    pickLabel('Cancel');
    expect(await confirmation.confirmOverwriteNewer('Production', ['a.php'])).toBe(false);
    pickLabel(undefined);
    expect(await confirmation.confirmOverwriteNewer('Production', ['a.php'])).toBe(false);
  });

  it('never offers "don\'t ask again" and never suppresses', async () => {
    mockGlobalState.get.mockReturnValue(true);
    pickLabel('Overwrite');
    await confirmation.confirmOverwriteNewer('Production', ['a.php']);
    expect(mockShowPick).toHaveBeenCalled();
    expect(shownLabels()).not.toContain("Upload, don't ask again");
    expect(mockGlobalState.update).not.toHaveBeenCalled();
  });
});

describe('UploadConfirmation.confirmUploadExcluded (force upload, 36b)', () => {
  let confirmation: UploadConfirmation;

  beforeEach(() => {
    jest.clearAllMocks();
    confirmation = new UploadConfirmation(mockGlobalState as any, mockOutput as any, mockShowPick);
  });

  it('names the excluded file and offers Upload anyway / Cancel', async () => {
    pickLabel('Upload anyway');
    await confirmation.confirmUploadExcluded('/workspace/debug.log');
    expect(shownTitle()).toBe('debug.log matches an excluded path. Upload it anyway?');
    expect(shownLabels()).toEqual(['Upload anyway', 'Cancel']);
    expect(shownItem('Upload anyway').detail ?? '').toContain('/workspace/debug.log');
  });

  it('returns true only for Upload anyway', async () => {
    pickLabel('Upload anyway');
    expect(await confirmation.confirmUploadExcluded('/workspace/debug.log')).toBe(true);
    pickLabel('Cancel');
    expect(await confirmation.confirmUploadExcluded('/workspace/debug.log')).toBe(false);
    pickLabel(undefined);
    expect(await confirmation.confirmUploadExcluded('/workspace/debug.log')).toBe(false);
  });
});
