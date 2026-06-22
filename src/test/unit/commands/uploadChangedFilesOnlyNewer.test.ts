import * as vscode from 'vscode';

jest.mock('../../../commands/uploadChangedFilesSelection', () => ({
  uploadChangedFilesSelection: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../commands/uploadAllChanged', () => ({
  uploadAllChanged: jest.fn().mockResolvedValue(undefined),
}));

import { uploadChangedFilesSelection } from '../../../commands/uploadChangedFilesSelection';
import { uploadAllChanged } from '../../../commands/uploadAllChanged';
import { uploadChangedFilesOnlyNewer } from '../../../commands/uploadChangedFilesOnlyNewer';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockSelection = uploadChangedFilesSelection as jest.Mock;
const mockAll = uploadAllChanged as jest.Mock;

const deps = {
  credentialManager: {} as CredentialManager,
  configManager: {} as ProjectConfigManager,
  context: {} as vscode.ExtensionContext,
  output: { appendLine: jest.fn() } as unknown as vscode.OutputChannel,
};

function fileItem(fsPath: string): vscode.TreeItem {
  const item = new vscode.TreeItem(vscode.Uri.file(fsPath));
  item.resourceUri = vscode.Uri.file(fsPath);
  return item;
}

function placeholderItem(): vscode.TreeItem {
  return new vscode.TreeItem('No changes'); // no resourceUri
}

describe('uploadChangedFilesOnlyNewer (adaptive)', () => {
  beforeEach(() => {
    mockSelection.mockClear();
    mockAll.mockClear();
  });

  it('uploads the SELECTED rows (only-newer) when files are selected', async () => {
    const getSelection = () => [fileItem('/workspace/a.php')];

    await uploadChangedFilesOnlyNewer(getSelection, deps);

    expect(mockSelection).toHaveBeenCalledWith(getSelection, deps, { onlyNewer: true });
    expect(mockAll).not.toHaveBeenCalled();
  });

  it('uploads ALL changed (only-newer) when nothing is selected', async () => {
    await uploadChangedFilesOnlyNewer(() => [], deps);

    expect(mockAll).toHaveBeenCalledWith(deps, { onlyNewer: true });
    expect(mockSelection).not.toHaveBeenCalled();
  });

  it('treats a selection of only placeholders (no resourceUri) as empty → all changed', async () => {
    await uploadChangedFilesOnlyNewer(() => [placeholderItem()], deps);

    expect(mockAll).toHaveBeenCalledWith(deps, { onlyNewer: true });
    expect(mockSelection).not.toHaveBeenCalled();
  });
});
