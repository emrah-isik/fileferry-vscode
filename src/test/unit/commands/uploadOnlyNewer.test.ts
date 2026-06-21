import * as vscode from 'vscode';

jest.mock('../../../commands/uploadAllChanged');

import { uploadAllChanged } from '../../../commands/uploadAllChanged';
import { uploadOnlyNewer } from '../../../commands/uploadOnlyNewer';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockUploadAllChanged = uploadAllChanged as jest.Mock;

const mockCredentialManager = {} as CredentialManager;
const mockConfigManager = {} as ProjectConfigManager;
const mockContext = {} as vscode.ExtensionContext;
const mockOutput = { appendLine: jest.fn(), show: jest.fn() } as unknown as vscode.OutputChannel;

function dependencies() {
  return {
    credentialManager: mockCredentialManager,
    configManager: mockConfigManager,
    context: mockContext,
    output: mockOutput,
  };
}

describe('uploadOnlyNewer command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadAllChanged.mockResolvedValue(undefined);
  });

  it('delegates to uploadAllChanged with the onlyNewer option set', async () => {
    const deps = dependencies();
    await uploadOnlyNewer(deps);
    expect(mockUploadAllChanged).toHaveBeenCalledWith(deps, { onlyNewer: true });
  });
});
