import { ScmResourceResolver } from '../../../scm/ScmResourceResolver';
import * as vscode from 'vscode';
import * as fs from 'fs';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
}));

const mockExistsSync = fs.existsSync as jest.Mock;

function makeResource(fsPath: string): vscode.SourceControlResourceState {
  return { resourceUri: vscode.Uri.file(fsPath) } as vscode.SourceControlResourceState;
}

describe('ScmResourceResolver', () => {
  let resolver: ScmResourceResolver;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    resolver = new ScmResourceResolver();
  });

  it('extracts single file path into toUpload for existing file', () => {
    const resource = makeResource('/workspace/src/app.php');
    const result = resolver.resolve(resource, undefined);
    expect(result).toEqual({ toUpload: ['/workspace/src/app.php'], toDelete: [] });
  });

  it('extracts multiple file paths into toUpload when all exist', () => {
    const resources = [
      makeResource('/workspace/src/a.php'),
      makeResource('/workspace/src/b.php'),
    ];
    const result = resolver.resolve(resources[0], resources);
    expect(result).toEqual({ toUpload: ['/workspace/src/a.php', '/workspace/src/b.php'], toDelete: [] });
  });

  it('deduplicates paths if same file appears twice', () => {
    const resource = makeResource('/workspace/src/app.php');
    const result = resolver.resolve(resource, [resource, resource]);
    expect(result).toEqual({ toUpload: ['/workspace/src/app.php'], toDelete: [] });
  });

  it('returns empty toUpload and toDelete when both arguments are undefined', () => {
    const result = resolver.resolve(undefined, undefined);
    expect(result).toEqual({ toUpload: [], toDelete: [] });
  });

  it('places deleted files (not on disk) into toDelete', () => {
    mockExistsSync.mockReturnValue(false);
    const resource = makeResource('/workspace/src/deleted.php');
    const result = resolver.resolve(resource, [resource]);
    expect(result).toEqual({ toUpload: [], toDelete: ['/workspace/src/deleted.php'] });
  });

  it('separates mixed existing and deleted files', () => {
    mockExistsSync
      .mockReturnValueOnce(true)   // app.php exists
      .mockReturnValueOnce(false); // deleted.php does not
    const existing = makeResource('/workspace/src/app.php');
    const deleted = makeResource('/workspace/src/deleted.php');
    const result = resolver.resolve(existing, [existing, deleted]);
    expect(result).toEqual({
      toUpload: ['/workspace/src/app.php'],
      toDelete: ['/workspace/src/deleted.php'],
    });
  });
});
