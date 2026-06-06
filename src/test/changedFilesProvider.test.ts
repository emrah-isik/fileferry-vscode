import { ChangedFilesProvider } from '../changedFiles/ChangedFilesProvider';
import { GitService } from '../gitService';
import { GitFile } from '../types';

const mockFiles: GitFile[] = [
  { absolutePath: '/proj/src/a.php', relativePath: 'src/a.php', workspaceRoot: '/proj', status: 'modified', checked: false },
  { absolutePath: '/proj/draft.php', relativePath: 'draft.php', workspaceRoot: '/proj', status: 'untracked', checked: false },
];

function makeProvider(files: GitFile[], root: string | undefined = '/proj') {
  const gitService = {
    getChangedFiles: jest.fn().mockReturnValue(files),
  } as unknown as GitService;
  return new ChangedFilesProvider(gitService, () => root);
}

function makeProviderNoRoot() {
  const gitService = {
    getChangedFiles: jest.fn().mockReturnValue(mockFiles),
  } as unknown as GitService;
  return new ChangedFilesProvider(gitService, () => undefined);
}

describe('ChangedFilesProvider context menu support', () => {
  it('marks each changed-file item with the "changedFile" contextValue', async () => {
    const provider = makeProvider(mockFiles);
    const items = await provider.getChildren();

    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.contextValue).toBe('changedFile');
    }
  });

  it('leaves the "No changes" placeholder without a contextValue', async () => {
    const provider = makeProvider([]);
    const items = await provider.getChildren();

    expect(items).toHaveLength(1);
    expect(items[0].contextValue).toBeUndefined();
  });

  it('leaves the no-workspace placeholder without a contextValue', async () => {
    const provider = makeProviderNoRoot();
    const items = await provider.getChildren();

    expect(items).toHaveLength(1);
    expect(items[0].contextValue).toBeUndefined();
  });
});
