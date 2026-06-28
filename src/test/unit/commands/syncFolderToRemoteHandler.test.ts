import * as vscode from 'vscode';

jest.mock('../../../commands/syncToRemote');

import { syncFolderToRemote } from '../../../commands/syncToRemote';
import { makeSyncFolderToRemoteHandler } from '../../../commands/syncFolderToRemoteHandler';

const dependencies = {
  credentialManager: {} as any,
  configManager: {} as any,
  context: {} as any,
  output: {} as any,
};

describe('makeSyncFolderToRemoteHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forwards the selected folder paths from an Explorer (Uri, Uri[]) invocation', () => {
    const folderA = vscode.Uri.file('/workspace/public/assets');
    const folderB = vscode.Uri.file('/workspace/src');
    const handler = makeSyncFolderToRemoteHandler(dependencies);

    handler(folderA, [folderA, folderB]);

    expect(syncFolderToRemote).toHaveBeenCalledWith(
      ['/workspace/public/assets', '/workspace/src'],
      dependencies
    );
  });

  it('forwards a single right-clicked folder', () => {
    const folder = vscode.Uri.file('/workspace/public');
    const handler = makeSyncFolderToRemoteHandler(dependencies);

    handler(folder, [folder]);

    expect(syncFolderToRemote).toHaveBeenCalledWith(['/workspace/public'], dependencies);
  });
});
