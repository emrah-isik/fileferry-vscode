import { ProjectConfigManager } from '../../../storage/ProjectConfigManager';
import { ProjectConfig, ProjectServer } from '../../../models/ProjectConfig';

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  appendFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/test-workspace' } }]
  },
  EventEmitter: class EventEmitter {
    private listeners: Array<(...args: any[]) => void> = [];
    event = (listener: (...args: any[]) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire = (...args: any[]) => { this.listeners.forEach(l => l(...args)); };
    dispose = () => { this.listeners = []; };
  },
}));

import * as fs from 'fs/promises';
import { HookCommand } from '../../../models/ProjectConfig';
const mockReadFile = fs.readFile as jest.Mock;
const mockWriteFile = fs.writeFile as jest.Mock;
const mockAppendFile = fs.appendFile as jest.Mock;

// Routes readFile by which config file the manager asks for, so getEffectiveConfig
// (committed base + git-ignored local override) can be exercised in one test.
function mockReadByPath(files: { committed?: string; local?: string; gitignore?: string }): void {
  mockReadFile.mockImplementation((filePath: string) => {
    if (filePath.endsWith('fileferry.local.json')) {
      return files.local !== undefined ? Promise.resolve(files.local) : Promise.reject({ code: 'ENOENT' });
    }
    if (filePath.endsWith('fileferry.json')) {
      return files.committed !== undefined ? Promise.resolve(files.committed) : Promise.reject({ code: 'ENOENT' });
    }
    if (filePath.endsWith('.gitignore')) {
      return files.gitignore !== undefined ? Promise.resolve(files.gitignore) : Promise.reject({ code: 'ENOENT' });
    }
    return Promise.reject({ code: 'ENOENT' });
  });
}

const localHooks: HookCommand[] = [{ command: 'mysql -p"$DB_PASS" < dump.sql', location: 'remote' }];
const committedHooks: HookCommand[] = [{ command: 'npm run build', location: 'local' }];

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

describe('ProjectConfigManager — onDidSaveConfig', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('fires onDidSaveConfig when saveConfig is called', async () => {
    const listener = jest.fn();
    manager.onDidSaveConfig(listener);
    await manager.saveConfig(configFixture);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires onDidSaveConfig for indirect mutations like setDefaultServer', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    const listener = jest.fn();
    manager.onDidSaveConfig(listener);
    await manager.setDefaultServer('uuid-prod-1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('disposed listeners are not invoked', async () => {
    const listener = jest.fn();
    const subscription = manager.onDidSaveConfig(listener);
    subscription.dispose();
    await manager.saveConfig(configFixture);
    expect(listener).not.toHaveBeenCalled();
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

describe('ProjectConfigManager — toggleSyncBackupBeforeDelete', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('disables syncBackupBeforeDelete when currently undefined (default is on)', async () => {
    const noFlag = { ...configFixture };
    delete (noFlag as Record<string, unknown>).syncBackupBeforeDelete;
    mockReadFile.mockResolvedValue(JSON.stringify(noFlag));
    const result = await manager.toggleSyncBackupBeforeDelete();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.syncBackupBeforeDelete).toBe(false);
    expect(result).toBe(false);
  });

  it('enables syncBackupBeforeDelete when currently false', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ ...configFixture, syncBackupBeforeDelete: false }));
    const result = await manager.toggleSyncBackupBeforeDelete();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.syncBackupBeforeDelete).toBe(true);
    expect(result).toBe(true);
  });

  it('creates a new config if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    const result = await manager.toggleSyncBackupBeforeDelete();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.syncBackupBeforeDelete).toBe(false);
    expect(result).toBe(false);
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

describe('ProjectConfigManager — toggleDryRun', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('enables dryRun when currently undefined (default is off)', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    const result = await manager.toggleDryRun();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.dryRun).toBe(true);
    expect(result).toBe(true);
  });

  it('disables dryRun when currently true', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ ...configFixture, dryRun: true }));
    const result = await manager.toggleDryRun();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.dryRun).toBe(false);
    expect(result).toBe(false);
  });

  it('enables dryRun when currently false', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ ...configFixture, dryRun: false }));
    const result = await manager.toggleDryRun();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.dryRun).toBe(true);
    expect(result).toBe(true);
  });

  it('creates a new config if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    const result = await manager.toggleDryRun();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.dryRun).toBe(true);
    expect(result).toBe(true);
  });
});

describe('ProjectConfigManager — toggleWatch', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('enables watch (preserving empty patterns) when currently undefined', async () => {
    const noFlag = { ...configFixture };
    delete (noFlag as Record<string, unknown>).watch;
    mockReadFile.mockResolvedValue(JSON.stringify(noFlag));
    const result = await manager.toggleWatch();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.watch).toEqual({ enabled: true, patterns: [] });
    expect(result).toBe(true);
  });

  it('disables watch but keeps the existing patterns', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      ...configFixture,
      watch: { enabled: true, patterns: ['dist/**'] },
    }));
    const result = await manager.toggleWatch();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.watch).toEqual({ enabled: false, patterns: ['dist/**'] });
    expect(result).toBe(false);
  });

  it('creates a new config if none exists', async () => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    const result = await manager.toggleWatch();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.watch).toEqual({ enabled: true, patterns: [] });
    expect(result).toBe(true);
  });
});

describe('ProjectConfigManager — setWatchPatterns', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('sets patterns while preserving the enabled flag', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      ...configFixture,
      watch: { enabled: true, patterns: ['old/**'] },
    }));
    await manager.setWatchPatterns(['dist/**', 'build/**/*.js']);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.watch).toEqual({ enabled: true, patterns: ['dist/**', 'build/**/*.js'] });
  });

  it('defaults enabled to false when watch was undefined', async () => {
    const noFlag = { ...configFixture };
    delete (noFlag as Record<string, unknown>).watch;
    mockReadFile.mockResolvedValue(JSON.stringify(noFlag));
    await manager.setWatchPatterns(['dist/**']);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.watch).toEqual({ enabled: false, patterns: ['dist/**'] });
  });
});

describe('ProjectConfigManager — setServerHooks', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('sets hooks on the named server and writes the committed config', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    await manager.setServerHooks('production', { preDeploy: committedHooks });
    const writePath = mockWriteFile.mock.calls[0][0] as string;
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(writePath).toContain('.vscode/fileferry.json');
    expect(written.servers['production'].hooks).toEqual({ preDeploy: committedHooks });
  });

  it('fires onDidSaveConfig', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    const listener = jest.fn();
    manager.onDidSaveConfig(listener);
    await manager.setServerHooks('production', { postDeploy: committedHooks });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('throws when the server does not exist', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(configFixture));
    await expect(manager.setServerHooks('nonexistent', { preDeploy: committedHooks }))
      .rejects.toThrow('Server "nonexistent" not found');
  });
});

describe('ProjectConfigManager — getEffectiveConfig (fileferry.local.json merge)', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('returns the committed config unchanged when no local file exists', async () => {
    const committed = {
      ...configFixture,
      servers: { production: { ...serverFixture, hooks: { preDeploy: committedHooks } } },
    };
    mockReadByPath({ committed: JSON.stringify(committed) });
    const effective = await manager.getEffectiveConfig();
    expect(effective?.servers['production'].hooks).toEqual({ preDeploy: committedHooks });
  });

  it('returns null when no committed config exists', async () => {
    mockReadByPath({});
    expect(await manager.getEffectiveConfig()).toBeNull();
  });

  it('lets the local file override a server\'s hooks (local wins)', async () => {
    const committed = {
      ...configFixture,
      servers: { production: { ...serverFixture, hooks: { preDeploy: committedHooks } } },
    };
    const local = { servers: { production: { hooks: { postDeploy: localHooks } } } };
    mockReadByPath({ committed: JSON.stringify(committed), local: JSON.stringify(local) });
    const effective = await manager.getEffectiveConfig();
    expect(effective?.servers['production'].hooks).toEqual({ postDeploy: localHooks });
  });

  it('only merges hooks — other committed server fields are untouched', async () => {
    const committed = { ...configFixture, servers: { production: { ...serverFixture } } };
    const local = { servers: { production: { hooks: { preDeploy: localHooks } } } };
    mockReadByPath({ committed: JSON.stringify(committed), local: JSON.stringify(local) });
    const effective = await manager.getEffectiveConfig();
    expect(effective?.servers['production'].rootPath).toBe('/var/www/html');
    expect(effective?.servers['production'].hooks).toEqual({ preDeploy: localHooks });
  });

  it('leaves servers absent from the local file with their committed hooks', async () => {
    const committed = {
      ...configFixture,
      servers: {
        production: { ...serverFixture, hooks: { preDeploy: committedHooks } },
        staging: { ...serverFixture, id: 'uuid-staging-1', hooks: { postDeploy: committedHooks } },
      },
    };
    const local = { servers: { production: { hooks: { postDeploy: localHooks } } } };
    mockReadByPath({ committed: JSON.stringify(committed), local: JSON.stringify(local) });
    const effective = await manager.getEffectiveConfig();
    expect(effective?.servers['production'].hooks).toEqual({ postDeploy: localHooks });
    expect(effective?.servers['staging'].hooks).toEqual({ postDeploy: committedHooks });
  });

  it('ignores local hooks for a server not present in the committed config', async () => {
    const committed = { ...configFixture, servers: { production: { ...serverFixture } } };
    const local = { servers: { ghost: { hooks: { preDeploy: localHooks } } } };
    mockReadByPath({ committed: JSON.stringify(committed), local: JSON.stringify(local) });
    const effective = await manager.getEffectiveConfig();
    expect(effective?.servers['ghost']).toBeUndefined();
    expect(effective?.servers['production'].hooks).toBeUndefined();
  });
});

describe('ProjectConfigManager — getServerHooks (effective per-server hooks)', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('returns the committed hooks when no local override exists', async () => {
    const committed = {
      ...configFixture,
      servers: { production: { ...serverFixture, hooks: { preDeploy: committedHooks } } },
    };
    mockReadByPath({ committed: JSON.stringify(committed) });
    expect(await manager.getServerHooks('production')).toEqual({ preDeploy: committedHooks });
  });

  it('returns the local override hooks when present (local wins)', async () => {
    const committed = {
      ...configFixture,
      servers: { production: { ...serverFixture, hooks: { preDeploy: committedHooks } } },
    };
    const local = { servers: { production: { hooks: { postDeploy: localHooks } } } };
    mockReadByPath({ committed: JSON.stringify(committed), local: JSON.stringify(local) });
    expect(await manager.getServerHooks('production')).toEqual({ postDeploy: localHooks });
  });

  it('returns undefined when the server has no hooks', async () => {
    mockReadByPath({ committed: JSON.stringify(configFixture) });
    expect(await manager.getServerHooks('production')).toBeUndefined();
  });

  it('returns undefined for an unknown server', async () => {
    mockReadByPath({ committed: JSON.stringify(configFixture) });
    expect(await manager.getServerHooks('nope')).toBeUndefined();
  });
});

describe('ProjectConfigManager — setLocalServerHooks', () => {
  let manager: ProjectConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProjectConfigManager();
  });

  it('writes hooks to fileferry.local.json (never the committed file)', async () => {
    mockReadByPath({});
    await manager.setLocalServerHooks('production', { postDeploy: localHooks });
    const writePath = mockWriteFile.mock.calls[0][0] as string;
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(writePath).toContain('.vscode/fileferry.local.json');
    expect(written.servers['production'].hooks).toEqual({ postDeploy: localHooks });
  });

  it('appends fileferry.local.json to .gitignore on first write', async () => {
    mockReadByPath({ gitignore: 'node_modules\n' });
    await manager.setLocalServerHooks('production', { postDeploy: localHooks });
    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const [appendPath, appended] = mockAppendFile.mock.calls[0];
    expect(appendPath).toContain('.gitignore');
    expect(appended).toContain('.vscode/fileferry.local.json');
  });

  it('does not duplicate the .gitignore entry when it is already present', async () => {
    mockReadByPath({ gitignore: 'node_modules\n.vscode/fileferry.local.json\n' });
    await manager.setLocalServerHooks('production', { postDeploy: localHooks });
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it('merges into existing local hooks for other servers', async () => {
    const existingLocal = { servers: { staging: { hooks: { preDeploy: localHooks } } } };
    mockReadByPath({ local: JSON.stringify(existingLocal), gitignore: '.vscode/fileferry.local.json\n' });
    await manager.setLocalServerHooks('production', { postDeploy: localHooks });
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.servers['staging'].hooks).toEqual({ preDeploy: localHooks });
    expect(written.servers['production'].hooks).toEqual({ postDeploy: localHooks });
  });
});
