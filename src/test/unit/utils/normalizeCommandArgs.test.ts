import * as vscode from 'vscode';
import { normalizeCommandArgs } from '../../../utils/normalizeCommandArgs';

function makeUri(fsPath: string): vscode.Uri {
  return vscode.Uri.file(fsPath);
}

function makeResource(fsPath: string): vscode.SourceControlResourceState {
  return { resourceUri: vscode.Uri.file(fsPath) } as vscode.SourceControlResourceState;
}

describe('normalizeCommandArgs', () => {
  describe('when called from Explorer context (Uri args)', () => {
    it('wraps single Uri into resource with resourceUri', () => {
      const uri = makeUri('/workspace/src/app.php');
      const { resource } = normalizeCommandArgs(uri, undefined);
      expect(resource?.resourceUri.fsPath).toBe('/workspace/src/app.php');
    });

    it('wraps all selected Uris into allResources', () => {
      const uri1 = makeUri('/workspace/src/a.php');
      const uri2 = makeUri('/workspace/src/b.php');
      const { allResources } = normalizeCommandArgs(uri1, [uri1, uri2]);
      expect(allResources).toHaveLength(2);
      expect(allResources![0].resourceUri.fsPath).toBe('/workspace/src/a.php');
      expect(allResources![1].resourceUri.fsPath).toBe('/workspace/src/b.php');
    });

    it('uses single-item allResources when second arg is undefined', () => {
      const uri = makeUri('/workspace/src/app.php');
      const { allResources } = normalizeCommandArgs(uri, undefined);
      expect(allResources).toHaveLength(1);
      expect(allResources![0].resourceUri.fsPath).toBe('/workspace/src/app.php');
    });
  });

  describe('when called from SCM context (SourceControlResourceState args)', () => {
    it('passes resource through unchanged', () => {
      const resource = makeResource('/workspace/src/app.php');
      const { resource: out } = normalizeCommandArgs(resource, undefined);
      expect(out).toBe(resource);
    });

    it('passes allResources through unchanged', () => {
      const r1 = makeResource('/workspace/src/a.php');
      const r2 = makeResource('/workspace/src/b.php');
      const { allResources } = normalizeCommandArgs(r1, [r1, r2]);
      expect(allResources).toHaveLength(2);
      expect(allResources![0]).toBe(r1);
      expect(allResources![1]).toBe(r2);
    });
  });

  describe('when no args provided', () => {
    it('returns undefined resource and allResources', () => {
      const { resource, allResources } = normalizeCommandArgs(undefined, undefined);
      expect(resource).toBeUndefined();
      expect(allResources).toBeUndefined();
    });
  });
});
