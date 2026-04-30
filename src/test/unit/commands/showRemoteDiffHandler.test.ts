import * as vscode from 'vscode';

jest.mock('../../../commands/showRemoteDiff', () => ({
  showRemoteDiff: jest.fn().mockResolvedValue(undefined),
}));

import { makeShowRemoteDiffHandler } from '../../../commands/showRemoteDiffHandler';
import { showRemoteDiff } from '../../../commands/showRemoteDiff';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockShowRemoteDiff = showRemoteDiff as jest.Mock;

const deps = {
  credentialManager: {} as CredentialManager,
  configManager: {} as ProjectConfigManager,
};

function makeResource(fsPath: string): vscode.SourceControlResourceState {
  return { resourceUri: vscode.Uri.file(fsPath) } as vscode.SourceControlResourceState;
}

describe('makeShowRemoteDiffHandler — VSCode invocation contract', () => {
  beforeEach(() => {
    mockShowRemoteDiff.mockClear();
  });

  it('forwards the right-clicked SCM resource (single-file diff)', async () => {
    const r1 = makeResource('/workspace/a.php');
    const r2 = makeResource('/workspace/b.php');

    const handler = makeShowRemoteDiffHandler(deps);
    // Even with multi-selection, diff acts on the primary
    await handler(r1, r2);

    const [resource] = mockShowRemoteDiff.mock.calls[0];
    expect(resource).toBe(r1);
  });

  it('forwards Explorer Uri', async () => {
    const u1 = vscode.Uri.file('/workspace/a.php');

    const handler = makeShowRemoteDiffHandler(deps);
    await handler(u1, [u1]);

    const [resource] = mockShowRemoteDiff.mock.calls[0];
    expect(resource.resourceUri.fsPath).toBe('/workspace/a.php');
  });
});
