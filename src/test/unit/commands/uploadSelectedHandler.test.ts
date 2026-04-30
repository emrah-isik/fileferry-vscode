import * as vscode from 'vscode';

jest.mock('../../../commands/uploadSelected', () => ({
  uploadSelected: jest.fn().mockResolvedValue(undefined),
}));

import { makeUploadSelectedHandler } from '../../../commands/uploadSelectedHandler';
import { uploadSelected } from '../../../commands/uploadSelected';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockUploadSelected = uploadSelected as jest.Mock;

const deps = {
  credentialManager: {} as CredentialManager,
  configManager: {} as ProjectConfigManager,
  context: { globalState: {} } as vscode.ExtensionContext,
  output: { appendLine: jest.fn() } as unknown as vscode.OutputChannel,
};

function makeResource(fsPath: string): vscode.SourceControlResourceState {
  return { resourceUri: vscode.Uri.file(fsPath) } as vscode.SourceControlResourceState;
}

describe('makeUploadSelectedHandler — VSCode invocation contract', () => {
  beforeEach(() => {
    mockUploadSelected.mockClear();
  });

  it('forwards all 4 variadic SCM resources to uploadSelected (the bug we fixed)', async () => {
    // VSCode's scm/resourceState/context calls handlers as (...resourceStates).
    // Selecting 4 files in SCM and right-clicking → 4 separate args.
    const r1 = makeResource('/workspace/a.php');
    const r2 = makeResource('/workspace/b.php');
    const r3 = makeResource('/workspace/c.php');
    const r4 = makeResource('/workspace/d.php');

    const handler = makeUploadSelectedHandler(deps);
    await handler(r1, r2, r3, r4);

    expect(mockUploadSelected).toHaveBeenCalledTimes(1);
    const [primary, allResources] = mockUploadSelected.mock.calls[0];
    expect(primary).toBe(r1);
    expect(allResources).toHaveLength(4);
    expect(allResources[0]).toBe(r1);
    expect(allResources[3]).toBe(r4);
  });

  it('forwards a single SCM resource as a 1-element selection', async () => {
    const r1 = makeResource('/workspace/a.php');
    const handler = makeUploadSelectedHandler(deps);
    await handler(r1);

    const [primary, allResources] = mockUploadSelected.mock.calls[0];
    expect(primary).toBe(r1);
    expect(allResources).toHaveLength(1);
    expect(allResources[0]).toBe(r1);
  });

  it('forwards Explorer (Uri, Uri[]) shape correctly', async () => {
    const u1 = vscode.Uri.file('/workspace/a.php');
    const u2 = vscode.Uri.file('/workspace/b.php');

    const handler = makeUploadSelectedHandler(deps);
    await handler(u1, [u1, u2]);

    const [primary, allResources] = mockUploadSelected.mock.calls[0];
    expect(primary.resourceUri.fsPath).toBe('/workspace/a.php');
    expect(allResources).toHaveLength(2);
    expect(allResources[1].resourceUri.fsPath).toBe('/workspace/b.php');
  });
});
