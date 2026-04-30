import * as vscode from 'vscode';

jest.mock('../../../commands/uploadToServers', () => ({
  uploadToServers: jest.fn().mockResolvedValue(undefined),
}));

import { makeUploadToServersHandler } from '../../../commands/uploadToServersHandler';
import { uploadToServers } from '../../../commands/uploadToServers';
import type { CredentialManager } from '../../../storage/CredentialManager';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

const mockUploadToServers = uploadToServers as jest.Mock;

const deps = {
  credentialManager: {} as CredentialManager,
  configManager: {} as ProjectConfigManager,
  context: { globalState: {} } as vscode.ExtensionContext,
  output: { appendLine: jest.fn() } as unknown as vscode.OutputChannel,
};

function makeResource(fsPath: string): vscode.SourceControlResourceState {
  return { resourceUri: vscode.Uri.file(fsPath) } as vscode.SourceControlResourceState;
}

describe('makeUploadToServersHandler — VSCode invocation contract', () => {
  beforeEach(() => {
    mockUploadToServers.mockClear();
  });

  it('forwards all variadic SCM resources to uploadToServers', async () => {
    const r1 = makeResource('/workspace/a.php');
    const r2 = makeResource('/workspace/b.php');
    const r3 = makeResource('/workspace/c.php');

    const handler = makeUploadToServersHandler(deps);
    await handler(r1, r2, r3);

    const [primary, allResources] = mockUploadToServers.mock.calls[0];
    expect(primary).toBe(r1);
    expect(allResources).toHaveLength(3);
    expect(allResources[2]).toBe(r3);
  });

  it('forwards Explorer (Uri, Uri[]) shape correctly', async () => {
    const u1 = vscode.Uri.file('/workspace/a.php');
    const u2 = vscode.Uri.file('/workspace/b.php');

    const handler = makeUploadToServersHandler(deps);
    await handler(u1, [u1, u2]);

    const [primary, allResources] = mockUploadToServers.mock.calls[0];
    expect(primary.resourceUri.fsPath).toBe('/workspace/a.php');
    expect(allResources).toHaveLength(2);
  });
});
