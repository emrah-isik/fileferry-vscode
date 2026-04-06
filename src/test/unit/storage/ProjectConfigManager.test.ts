import { ProjectConfigManager } from '../../../storage/ProjectConfigManager';
import { ProjectConfig, ProjectServer } from '../../../models/ProjectConfig';

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
const mockReadFile = fs.readFile as jest.Mock;
const mockWriteFile = fs.writeFile as jest.Mock;

const serverFixture: ProjectServer = {
  id: 'uuid-prod-1',
  type: 'sftp',
  credentialId: 'cred-uuid-1',
  credentialName: 'deploy@prod-server',
  rootPath: '/var/www/html',
  mappings: [{ localPath: '/', remotePath: '/var/www/html' }],
  excludedPaths: ['node_modules'],
};

const configFixture: ProjectConfig = {
  defaultServerId: 'uuid-prod-1',
  uploadOnSave: false,
  servers: {
    production: serverFixture,
  },
};

describe('ProjectConfigManager — read/write', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('returns null when fileferry.json does not exist', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    expect(await manager.getConfig()).toBeNull();
  });

  it('reads and parses existing fileferry.json', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    const config = await manager.getConfig();
    expect(config?.defaultServerId).toBe('uuid-prod-1');
    expect(config?.servers['production'].rootPath).toBe('/var/www/html');
  });

  it('writes fileferry.json to the correct workspace path', async () => {
    await manager.saveConfig(configFixture);
    expect(mockWriteFile.mock.calls[0][0]).toContain('.vscode/fileferry.json');
  });

  it('creates .vscode directory if it does not exist', async () => {
    await manager.saveConfig(configFixture);
    const mkdirCall = (fs.mkdir as jest.Mock).mock.calls[0];
    expect(mkdirCall[0]).toContain('.vscode');
    expect(mkdirCall[1]).toEqual({ recursive: true });
  });

  it('throws when no workspace is open', async () => {
    const vscode = require('vscode');
    vscode.workspace.workspaceFolders = null;
    await expect(manager.saveConfig(configFixture)).rejects.toThrow('No workspace open');
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/tmp/test-workspace' } }];
  });
});

describe('ProjectConfigManager — server CRUD', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    manager = new ProjectConfigManager();
  });

  it('adds a new server', async () => {
    const staging: ProjectServer = {
      id: 'uuid-staging-1',
      type: 'sftp',
      credentialId: 'cred-uuid-2',
      credentialName: 'deploy@staging',
      rootPath: '/var/www/staging',
      mappings: [{ localPath: '/', remotePath: '/var/www/staging' }],
      excludedPaths: [],
    };
    await manager.addServer('staging', staging);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['staging']).toBeDefined();
    expect(written.servers['staging'].credentialName).toBe('deploy@staging');
    expect(Object.keys(written.servers)).toHaveLength(2);
  });

  it('rejects adding a server with a duplicate name', async () => {
    await expect(manager.addServer('production', serverFixture))
      .rejects.toThrow('Server name "production" already exists');
  });

  it('removes a server by name', async () => {
    await manager.removeServer('production');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['production']).toBeUndefined();
  });

  it('clears defaultServerId when removing the default server', async () => {
    await manager.removeServer('production');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.defaultServerId).toBe('');
  });

  it('keeps defaultServerId when removing a non-default server', async () => {
    const twoServers: ProjectConfig = {
      ...configFixture,
      servers: {
        ...configFixture.servers,
        staging: { ...serverFixture, id: 'uuid-staging-1' },
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(twoServers));
    await manager.removeServer('staging');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.defaultServerId).toBe('uuid-prod-1');
  });

  it('renames a server', async () => {
    await manager.renameServer('production', 'live');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['live']).toBeDefined();
    expect(written.servers['production']).toBeUndefined();
    expect(written.servers['live'].id).toBe('uuid-prod-1');
  });

  it('preserves defaultServerId when renaming (UUID is stable)', async () => {
    await manager.renameServer('production', 'live');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.defaultServerId).toBe('uuid-prod-1');
  });

  it('rejects renaming to an existing name', async () => {
    const twoServers: ProjectConfig = {
      ...configFixture,
      servers: {
        ...configFixture.servers,
        staging: { ...serverFixture, id: 'uuid-staging-1' },
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(twoServers));
    await expect(manager.renameServer('production', 'staging'))
      .rejects.toThrow('Server name "staging" already exists');
  });

  it('rejects renaming a server that does not exist', async () => {
    await expect(manager.renameServer('nonexistent', 'live'))
      .rejects.toThrow('Server "nonexistent" not found');
  });

  it('sets the default server by id', async () => {
    await manager.setDefaultServer('uuid-prod-1');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.defaultServerId).toBe('uuid-prod-1');
  });

  it('gets a server by id', async () => {
    const result = await manager.getServerById('uuid-prod-1');
    expect(result?.name).toBe('production');
    expect(result?.server.rootPath).toBe('/var/www/html');
  });

  it('returns undefined for a nonexistent server id', async () => {
    expect(await manager.getServerById('nonexistent-id')).toBeUndefined();
  });

  it('gets a server by name', async () => {
    const server = await manager.getServer('production');
    expect(server?.id).toBe('uuid-prod-1');
    expect(server?.rootPath).toBe('/var/www/html');
  });

  it('returns undefined for a nonexistent server', async () => {
    expect(await manager.getServer('nonexistent')).toBeUndefined();
  });

  it('returns all server names', async () => {
    const names = await manager.getServerNames();
    expect(names).toEqual(['production']);
  });
});

describe('ProjectConfigManager — toggleUploadOnSave', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('enables uploadOnSave when currently undefined', async () => {
    const noFlag = { ...configFixture };
    delete (noFlag as Record<string, unknown>).uploadOnSave;
    mockReadFile.mockResolvedValue(JSON.stringify(noFlag));
    const result = await manager.toggleUploadOnSave();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.uploadOnSave).toBe(true);
    expect(result).toBe(true);
  });

  it('disables uploadOnSave when currently true', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ ...configFixture, uploadOnSave: true }));
    const result = await manager.toggleUploadOnSave();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.uploadOnSave).toBe(false);
    expect(result).toBe(false);
  });

  it('creates a new config if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    const result = await manager.toggleUploadOnSave();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.uploadOnSave).toBe(true);
    expect(result).toBe(true);
  });
});

describe('ProjectConfigManager — toggleFileDateGuard', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('disables fileDateGuard when currently undefined (default is on)', async () => {
    const noFlag = { ...configFixture };
    delete (noFlag as Record<string, unknown>).fileDateGuard;
    mockReadFile.mockResolvedValue(JSON.stringify(noFlag));
    const result = await manager.toggleFileDateGuard();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.fileDateGuard).toBe(false);
    expect(result).toBe(false);
  });

  it('enables fileDateGuard when currently false', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ ...configFixture, fileDateGuard: false }));
    const result = await manager.toggleFileDateGuard();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.fileDateGuard).toBe(true);
    expect(result).toBe(true);
  });

  it('creates a new config if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    const result = await manager.toggleFileDateGuard();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.fileDateGuard).toBe(false);
    expect(result).toBe(false);
  });
});

describe('ProjectConfigManager — toggleBackupBeforeOverwrite', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('enables backupBeforeOverwrite when currently undefined (default is off)', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    const result = await manager.toggleBackupBeforeOverwrite();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.backupBeforeOverwrite).toBe(true);
    expect(result).toBe(true);
  });

  it('disables backupBeforeOverwrite when currently true', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ ...configFixture, backupBeforeOverwrite: true }));
    const result = await manager.toggleBackupBeforeOverwrite();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.backupBeforeOverwrite).toBe(false);
    expect(result).toBe(false);
  });

  it('creates a new config if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    const result = await manager.toggleBackupBeforeOverwrite();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.backupBeforeOverwrite).toBe(true);
    expect(result).toBe(true);
  });
});

describe('ProjectConfigManager — setBackupRetentionDays', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('sets backupRetentionDays to the given value', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    await manager.setBackupRetentionDays(14);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.backupRetentionDays).toBe(14);
  });

  it('creates a new config if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    await manager.setBackupRetentionDays(3);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.backupRetentionDays).toBe(3);
  });
});

describe('ProjectConfigManager — setBackupMaxSizeMB', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('sets backupMaxSizeMB to the given value', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    await manager.setBackupMaxSizeMB(200);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.backupMaxSizeMB).toBe(200);
  });

  it('creates a new config if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    await manager.setBackupMaxSizeMB(50);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.backupMaxSizeMB).toBe(50);
  });
});
