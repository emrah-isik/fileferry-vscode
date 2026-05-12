import * as vscode from 'vscode';

jest.mock('../../../commands/uploadSelected', () => ({
  uploadSelected: jest.fn().mockResolvedValue(undefined),
}));

import { uploadChangedFilesSelection } from '../../../commands/uploadChangedFilesSelection';
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

function makeTreeItem(fsPath: string): vscode.TreeItem {
  const item = new vscode.TreeItem(vscode.Uri.file(fsPath));
  item.resourceUri = vscode.Uri.file(fsPath);
  return item;
}

function makePlaceholderItem(): vscode.TreeItem {
  // The "No changes" placeholder — no resourceUri
  return new vscode.TreeItem('No changes');
}

describe('uploadChangedFilesSelection', () => {
  let showWarningMessage: jest.Mock;

  beforeEach(() => {
    mockUploadSelected.mockClear();
    showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
    showWarningMessage.mockReset();
  });

  describe('with selected files', () => {
    it('forwards a single selected file to uploadSelected as primary + allResources', async () => {
      const item = makeTreeItem('/workspace/a.php');
      const getSelection = () => [item];

      await uploadChangedFilesSelection(getSelection, deps);

      expect(mockUploadSelected).toHaveBeenCalledTimes(1);
      const [primary, all, passedDeps] = mockUploadSelected.mock.calls[0];
      expect(primary.resourceUri.fsPath).toBe('/workspace/a.php');
      expect(all).toHaveLength(1);
      expect(all[0].resourceUri.fsPath).toBe('/workspace/a.php');
      expect(passedDeps).toBe(deps);
    });

    it('forwards multiple selected files preserving order', async () => {
      const items = [
        makeTreeItem('/workspace/a.php'),
        makeTreeItem('/workspace/b.php'),
        makeTreeItem('/workspace/c.php'),
        makeTreeItem('/workspace/d.php'),
      ];
      const getSelection = () => items;

      await uploadChangedFilesSelection(getSelection, deps);

      const [primary, all] = mockUploadSelected.mock.calls[0];
      expect(primary.resourceUri.fsPath).toBe('/workspace/a.php');
      expect(all).toHaveLength(4);
      expect(all.map((r: any) => r.resourceUri.fsPath)).toEqual([
        '/workspace/a.php',
        '/workspace/b.php',
        '/workspace/c.php',
        '/workspace/d.php',
      ]);
    });

    it('passes the deps object through unchanged', async () => {
      const item = makeTreeItem('/workspace/a.php');

      await uploadChangedFilesSelection(() => [item], deps);

      expect(mockUploadSelected.mock.calls[0][2]).toBe(deps);
    });

    it('does NOT show a warning when at least one file is selected', async () => {
      await uploadChangedFilesSelection(() => [makeTreeItem('/workspace/a.php')], deps);

      expect(showWarningMessage).not.toHaveBeenCalled();
    });
  });

  describe('empty selection', () => {
    it('shows a warning when the selection is empty', async () => {
      await uploadChangedFilesSelection(() => [], deps);

      expect(showWarningMessage).toHaveBeenCalledTimes(1);
      expect(showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('No files selected')
      );
    });

    it('does NOT call uploadSelected when the selection is empty', async () => {
      await uploadChangedFilesSelection(() => [], deps);

      expect(mockUploadSelected).not.toHaveBeenCalled();
    });
  });

  describe('placeholder filtering', () => {
    it('ignores the "No changes" placeholder item (no resourceUri)', async () => {
      await uploadChangedFilesSelection(() => [makePlaceholderItem()], deps);

      expect(mockUploadSelected).not.toHaveBeenCalled();
      expect(showWarningMessage).toHaveBeenCalled();
    });

    it('uploads valid file items even when the selection contains a placeholder', async () => {
      const items = [makePlaceholderItem(), makeTreeItem('/workspace/a.php')];

      await uploadChangedFilesSelection(() => items, deps);

      const [primary, all] = mockUploadSelected.mock.calls[0];
      expect(primary.resourceUri.fsPath).toBe('/workspace/a.php');
      expect(all).toHaveLength(1);
    });
  });

  describe('signature contract — resource shape', () => {
    it('produces resource states with a resourceUri shaped like SourceControlResourceState', async () => {
      const item = makeTreeItem('/workspace/a.php');

      await uploadChangedFilesSelection(() => [item], deps);

      const [primary] = mockUploadSelected.mock.calls[0];
      expect(primary).toHaveProperty('resourceUri');
      expect(typeof primary.resourceUri.fsPath).toBe('string');
    });
  });
});
