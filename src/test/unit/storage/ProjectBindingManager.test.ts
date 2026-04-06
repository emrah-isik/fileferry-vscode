import { ProjectBindingManager } from '../../../storage/ProjectBindingManager';
import { ProjectBinding } from '../../../models/ProjectBinding';

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/test-workspace' } }]
  }
}));

import * as fs from 'fs/promises';
const mockReadFile  = fs.readFile as jest.Mock;
const mockWriteFile = fs.writeFile as jest.Mock;

const bindingFixture: ProjectBinding = {
  defaultServerId: 'srv-1',
  servers: {
    'srv-1': {
      mappings: [{ localPath: '/', remotePath: '/var/www' }],
      excludedPaths: ['node_modules']
    }
  }
};

describe('ProjectBindingManager', () => {
  let manager: ProjectBindingManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectBindingManager();
  });

  it('returns null when .vscode/fileferry.json does not exist', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    expect(await manager.getBinding()).toBeNull();
  });

  it('reads and parses existing fileferry.json', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(bindingFixture));
    const binding = await manager.getBinding();
    expect(binding?.defaultServerId).toBe('srv-1');
    expect(binding?.servers['srv-1'].mappings).toHaveLength(1);
  });

  it('writes fileferry.json to the correct workspace path', async () => {
    await manager.saveBinding(bindingFixture);
    expect(mockWriteFile.mock.calls[0][0]).toContain('.vscode/fileferry.json');
  });

  it('creates .vscode directory if it does not exist', async () => {
    await manager.saveBinding(bindingFixture);
    const mkdirCall = (fs.mkdir as jest.Mock).mock.calls[0];
    expect(mkdirCall[0]).toContain('.vscode');
    expect(mkdirCall[1]).toEqual({ recursive: true });
  });

  it('updates defaultServerId', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(bindingFixture));
    await manager.setDefaultServer('srv-2');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.defaultServerId).toBe('srv-2');
  });

  it('adds a server binding entry', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(bindingFixture));
    await manager.setServerBinding('srv-2', {
      mappings: [{ localPath: '/', remotePath: '/var/staging' }],
      excludedPaths: []
    });
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['srv-2']).toBeDefined();
    expect(Object.keys(written.servers)).toHaveLength(2);
  });

  it('removes a server binding entry', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(bindingFixture));
    await manager.removeServerBinding('srv-1');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['srv-1']).toBeUndefined();
  });

  it('throws when saving binding with no workspace open', async () => {
    const vscode = require('vscode');
    vscode.workspace.workspaceFolders = null;
    await expect(manager.saveBinding(bindingFixture)).rejects.toThrow('No workspace open');
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/tmp/test-workspace' } }];
  });

  it('resolves remote path using longest prefix match', () => {
    const binding = {
      mappings: [
        { localPath: '/', remotePath: '/var/www' },
        { localPath: '/public', remotePath: '/var/www/public_html' }
      ],
      excludedPaths: []
    };
    const result = manager.resolveRemotePath(binding, 'public/index.php');
    expect(result).toBe('/var/www/public_html/index.php');
  });

  it('resolveRemotePath returns null for excluded paths', () => {
    const binding = {
      mappings: [{ localPath: '/', remotePath: '/var/www' }],
      excludedPaths: ['node_modules']
    };
    expect(manager.resolveRemotePath(binding, 'node_modules/lodash/index.js')).toBeNull();
  });

  it('resolveRemotePath returns null when no mapping matches', () => {
    const binding = { mappings: [], excludedPaths: [] };
    expect(manager.resolveRemotePath(binding, 'src/app.php')).toBeNull();
  });
});

describe('ProjectBindingManager — mapping operations', () => {
  let manager: ProjectBindingManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockResolvedValue(JSON.stringify(bindingFixture));
    manager = new ProjectBindingManager();
  });

  it('addMapping appends to the server mappings array', async () => {
    await manager.addMapping('srv-1', { localPath: '/src', remotePath: '/var/www/src' });
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['srv-1'].mappings).toHaveLength(2);
    expect(written.servers['srv-1'].mappings[1].localPath).toBe('/src');
  });

  it('removeMapping removes by index', async () => {
    await manager.removeMapping('srv-1', 0);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['srv-1'].mappings).toHaveLength(0);
  });

  it('updateMapping replaces entry at index', async () => {
    await manager.updateMapping('srv-1', 0, { localPath: '/public', remotePath: '/var/www/html' });
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['srv-1'].mappings[0].localPath).toBe('/public');
    expect(written.servers['srv-1'].mappings).toHaveLength(1);
  });

  it('addExcludedPath appends to excludedPaths', async () => {
    await manager.addExcludedPath('srv-1', '*.log');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['srv-1'].excludedPaths).toContain('node_modules');
    expect(written.servers['srv-1'].excludedPaths).toContain('*.log');
  });

  it('removeExcludedPath removes by value', async () => {
    await manager.removeExcludedPath('srv-1', 'node_modules');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['srv-1'].excludedPaths).not.toContain('node_modules');
  });

  it('validateBinding rejects empty mappings array', () => {
    const errors = manager.validateBinding({ mappings: [], excludedPaths: [] });
    expect(errors.some(e => e.field === 'mappings')).toBe(true);
  });

  it('validateBinding rejects mappings with duplicate localPath', () => {
    const errors = manager.validateBinding({
      mappings: [
        { localPath: '/', remotePath: '/var/www' },
        { localPath: '/', remotePath: '/var/www/v2' },
      ],
      excludedPaths: [],
    });
    expect(errors.some(e => e.field === 'mappings')).toBe(true);
  });

  it('validateBinding rejects excluded path that does not look like a glob or simple name', () => {
    const errors = manager.validateBinding({
      mappings: [{ localPath: '/', remotePath: '/var/www' }],
      excludedPaths: [''],   // empty string is invalid
    });
    expect(errors.some(e => e.field === 'excludedPaths')).toBe(true);
  });

  it('validateBinding returns no errors for a valid binding', () => {
    const errors = manager.validateBinding({
      mappings: [{ localPath: '/', remotePath: '/var/www' }],
      excludedPaths: ['node_modules', '*.log'],
    });
    expect(errors).toHaveLength(0);
  });
});

describe('ProjectBindingManager — toggleUploadOnSave', () => {
  let manager: ProjectBindingManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectBindingManager();
  });

  it('enables uploadOnSave when currently undefined', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(bindingFixture));
    await manager.toggleUploadOnSave();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.uploadOnSave).toBe(true);
  });

  it('enables uploadOnSave when currently false', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ ...bindingFixture, uploadOnSave: false }));
    await manager.toggleUploadOnSave();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.uploadOnSave).toBe(true);
  });

  it('disables uploadOnSave when currently true', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ ...bindingFixture, uploadOnSave: true }));
    await manager.toggleUploadOnSave();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.uploadOnSave).toBe(false);
  });

  it('creates a new binding if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    await manager.toggleUploadOnSave();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.uploadOnSave).toBe(true);
  });
});
