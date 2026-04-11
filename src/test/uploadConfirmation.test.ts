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
