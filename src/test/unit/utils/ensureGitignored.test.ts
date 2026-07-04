jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  appendFile: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';
import { ensureGitignored } from '../../../utils/ensureGitignored';

const mockReadFile = fs.readFile as jest.Mock;
const mockAppendFile = fs.appendFile as jest.Mock;

describe('ensureGitignored', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates .gitignore with the entry when the file does not exist', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    await ensureGitignored('/ws', '.vscode/fileferry-history.jsonl');
    const [gitignorePath, appended] = mockAppendFile.mock.calls[0];
    expect(gitignorePath).toContain('.gitignore');
    expect(appended).toBe('.vscode/fileferry-history.jsonl\n');
  });

  it('appends the entry when the file exists without it', async () => {
    mockReadFile.mockResolvedValue('node_modules\n');
    await ensureGitignored('/ws', '.vscode/fileferry-backups/');
    expect(mockAppendFile.mock.calls[0][1]).toBe('.vscode/fileferry-backups/\n');
  });

  it('adds a leading newline when the file does not end in one', async () => {
    mockReadFile.mockResolvedValue('node_modules'); // no trailing newline
    await ensureGitignored('/ws', '.vscode/fileferry.local.json');
    expect(mockAppendFile.mock.calls[0][1]).toBe('\n.vscode/fileferry.local.json\n');
  });

  it('is idempotent — does not append when the entry is already present', async () => {
    mockReadFile.mockResolvedValue('node_modules\n.vscode/fileferry-history.jsonl\n');
    await ensureGitignored('/ws', '.vscode/fileferry-history.jsonl');
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it('matches an already-present entry even with surrounding whitespace', async () => {
    mockReadFile.mockResolvedValue('  .vscode/fileferry-backups/  \n');
    await ensureGitignored('/ws', '.vscode/fileferry-backups/');
    expect(mockAppendFile).not.toHaveBeenCalled();
  });
});
