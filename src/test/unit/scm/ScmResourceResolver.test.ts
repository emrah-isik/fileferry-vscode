import { ScmResourceResolver } from '../../../scm/ScmResourceResolver';
import * as vscode from 'vscode';
import * as fs from 'fs';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  statSync: jest.fn().mockReturnValue({ isDirectory: () => false }),
  readdirSync: jest.fn().mockReturnValue([]),
}));

const mockExistsSync = fs.existsSync as jest.Mock;
const mockStatSync = fs.statSync as jest.Mock;
const mockReaddirSync = fs.readdirSync as jest.Mock;

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

  describe('folder expansion', () => {
    it('expands a folder into its contained files recursively', () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync
        .mockReturnValueOnce({ isDirectory: () => true })   // /workspace/src is dir
        .mockReturnValueOnce({ isDirectory: () => false })   // app.php is file
        .mockReturnValueOnce({ isDirectory: () => true })    // sub/ is dir
        .mockReturnValueOnce({ isDirectory: () => false });  // helper.php is file

      mockReaddirSync
        .mockReturnValueOnce(['app.php', 'sub'])       // /workspace/src
        .mockReturnValueOnce(['helper.php']);           // /workspace/src/sub

      const resource = makeResource('/workspace/src');
      const result = resolver.resolve(resource, [resource]);

      expect(result.toUpload).toEqual([
        '/workspace/src/app.php',
        '/workspace/src/sub/helper.php',
      ]);
      expect(result.toDelete).toEqual([]);
    });

    it('returns empty toUpload for an empty folder', () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockReaddirSync.mockReturnValue([]);

      const resource = makeResource('/workspace/empty');
      const result = resolver.resolve(resource, [resource]);

      expect(result.toUpload).toEqual([]);
      expect(result.toDelete).toEqual([]);
    });

    it('handles mixed files and folders in a single selection', () => {
      // First resource is a file, second is a folder
      mockExistsSync.mockReturnValue(true);
      mockStatSync
        .mockReturnValueOnce({ isDirectory: () => false })  // index.php is file
        .mockReturnValueOnce({ isDirectory: () => true })   // css/ is dir
        .mockReturnValueOnce({ isDirectory: () => false });  // style.css is file

      mockReaddirSync
        .mockReturnValueOnce(['style.css']);  // /workspace/css

      const file = makeResource('/workspace/index.php');
      const folder = makeResource('/workspace/css');
      const result = resolver.resolve(file, [file, folder]);

      expect(result.toUpload).toEqual([
        '/workspace/index.php',
        '/workspace/css/style.css',
      ]);
    });

    it('does not include the folder path itself in toUpload', () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync
        .mockReturnValueOnce({ isDirectory: () => true })
        .mockReturnValueOnce({ isDirectory: () => false });
      mockReaddirSync.mockReturnValueOnce(['file.txt']);

      const resource = makeResource('/workspace/docs');
      const result = resolver.resolve(resource, [resource]);

      expect(result.toUpload).not.toContain('/workspace/docs');
      expect(result.toUpload).toEqual(['/workspace/docs/file.txt']);
    });
  });
});
