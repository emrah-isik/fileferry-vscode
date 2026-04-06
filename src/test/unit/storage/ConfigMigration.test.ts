import { migrateToProjectConfig, migrateIfNeeded } from '../../../storage/ConfigMigration';
import { DeploymentServer } from '../../../models/DeploymentServer';
import { ProjectBinding } from '../../../models/ProjectBinding';
import { ProjectConfig } from '../../../models/ProjectConfig';
import { SshCredential } from '../../../models/SshCredential';

describe('ConfigMigration — migrateToProjectConfig', () => {
  const credential: SshCredential = {
    id: 'cred-1',
    name: 'deploy@prod',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
  };

  const server: DeploymentServer = {
    id: 'srv-1',
    name: 'production',
    type: 'sftp',
    credentialId: 'cred-1',
    rootPath: '/var/www',
  };

  const binding: ProjectBinding = {
    defaultServerId: 'srv-1',
    uploadOnSave: true,
    servers: {
      'srv-1': {
        mappings: [{ localPath: '/', remotePath: '/var/www/html' }],
        excludedPaths: ['node_modules'],
        rootPathOverride: '/var/www/html',
      },
    },
  };

  it('merges a server + binding into a ProjectConfig', () => {
    const result = migrateToProjectConfig([server], binding, [credential]);
    expect(result.defaultServerId).toBe('srv-1');
    expect(result.servers['production']).toBeDefined();
    expect(result.servers['production'].id).toBe('srv-1');
    expect(result.servers['production'].credentialId).toBe('cred-1');
    expect(result.servers['production'].credentialName).toBe('deploy@prod');
    expect(result.servers['production'].type).toBe('sftp');
    expect(result.servers['production'].mappings).toEqual([
      { localPath: '/', remotePath: '/var/www/html' },
    ]);
    expect(result.servers['production'].excludedPaths).toEqual(['node_modules']);
  });

  it('uses rootPathOverride when present', () => {
    const result = migrateToProjectConfig([server], binding, [credential]);
    expect(result.servers['production'].rootPath).toBe('/var/www/html');
  });

  it('falls back to server rootPath when no override', () => {
    const bindingNoOverride: ProjectBinding = {
      defaultServerId: 'srv-1',
      servers: {
        'srv-1': {
          mappings: [{ localPath: '/', remotePath: '/var/www' }],
          excludedPaths: [],
        },
      },
    };
    const result = migrateToProjectConfig([server], bindingNoOverride, [credential]);
    expect(result.servers['production'].rootPath).toBe('/var/www');
  });

  it('preserves uploadOnSave flag', () => {
    const result = migrateToProjectConfig([server], binding, [credential]);
    expect(result.uploadOnSave).toBe(true);
  });

  it('handles multiple servers', () => {
    const server2: DeploymentServer = {
      id: 'srv-2',
      name: 'staging',
      type: 'sftp',
      credentialId: 'cred-1',
      rootPath: '/var/www/staging',
    };
    const multiBinding: ProjectBinding = {
      defaultServerId: 'srv-1',
      servers: {
        'srv-1': {
          mappings: [{ localPath: '/', remotePath: '/var/www' }],
          excludedPaths: [],
        },
        'srv-2': {
          mappings: [{ localPath: '/', remotePath: '/var/www/staging' }],
          excludedPaths: [],
        },
      },
    };
    const result = migrateToProjectConfig([server, server2], multiBinding, [credential]);
    expect(Object.keys(result.servers)).toHaveLength(2);
    expect(result.servers['production']).toBeDefined();
    expect(result.servers['staging']).toBeDefined();
  });

  it('skips servers not referenced in the binding', () => {
    const unreferencedServer: DeploymentServer = {
      id: 'srv-99',
      name: 'orphan',
      type: 'sftp',
      credentialId: 'cred-1',
      rootPath: '/tmp',
    };
    const result = migrateToProjectConfig(
      [server, unreferencedServer], binding, [credential]
    );
    expect(Object.keys(result.servers)).toHaveLength(1);
    expect(result.servers['orphan']).toBeUndefined();
  });

  it('handles duplicate server names by appending a suffix', () => {
    const server2: DeploymentServer = {
      id: 'srv-2',
      name: 'production',
      type: 'sftp',
      credentialId: 'cred-1',
      rootPath: '/var/www/v2',
    };
    const multiBinding: ProjectBinding = {
      defaultServerId: 'srv-1',
      servers: {
        'srv-1': {
          mappings: [{ localPath: '/', remotePath: '/var/www' }],
          excludedPaths: [],
        },
        'srv-2': {
          mappings: [{ localPath: '/', remotePath: '/var/www/v2' }],
          excludedPaths: [],
        },
      },
    };
    const result = migrateToProjectConfig([server, server2], multiBinding, [credential]);
    expect(Object.keys(result.servers)).toHaveLength(2);
    expect(result.servers['production']).toBeDefined();
    expect(result.servers['production-2']).toBeDefined();
  });

  it('sets credentialName to empty string when credential not found', () => {
    const result = migrateToProjectConfig([server], binding, []);
    expect(result.servers['production'].credentialId).toBe('cred-1');
    expect(result.servers['production'].credentialName).toBe('');
  });

  it('returns empty config when binding is null', () => {
    const result = migrateToProjectConfig([server], null, [credential]);
    expect(result.defaultServerId).toBe('');
    expect(Object.keys(result.servers)).toHaveLength(0);
  });
});

describe('migrateIfNeeded', () => {
  const credential: SshCredential = {
    id: 'cred-1',
    name: 'deploy@prod',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
  };

  const oldServers: DeploymentServer[] = [
    { id: 'srv-1', name: 'production', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' },
  ];

  const oldBinding: ProjectBinding = {
    defaultServerId: 'srv-1',
    uploadOnSave: true,
    servers: {
      'srv-1': {
        mappings: [{ localPath: '/', remotePath: '/var/www' }],
        excludedPaths: ['node_modules'],
      },
    },
  };

  function makeDeps(overrides: {
    existingConfig?: ProjectConfig | null;
    oldServers?: DeploymentServer[];
    oldBinding?: ProjectBinding | null;
    credentials?: SshCredential[];
  } = {}) {
    const saveConfig = jest.fn().mockResolvedValue(undefined);
    return {
      deps: {
        getExistingConfig: jest.fn().mockResolvedValue(overrides.existingConfig ?? null),
        readOldServers: jest.fn().mockResolvedValue(overrides.oldServers ?? []),
        readOldBinding: jest.fn().mockResolvedValue(overrides.oldBinding ?? null),
        getCredentials: jest.fn().mockResolvedValue(overrides.credentials ?? [credential]),
        saveConfig,
      },
      saveConfig,
    };
  }

  it('migrates when old data exists and no new config', async () => {
    const { deps, saveConfig } = makeDeps({ oldServers, oldBinding });
    const migrated = await migrateIfNeeded(deps);
    expect(migrated).toBe(true);
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultServerId: 'srv-1',
        servers: expect.objectContaining({
          production: expect.objectContaining({ id: 'srv-1', type: 'sftp' }),
        }),
      })
    );
  });

  it('skips migration when new config already has servers', async () => {
    const existingConfig: ProjectConfig = {
      defaultServerId: 'srv-1',
      servers: {
        Production: {
          id: 'srv-1', type: 'sftp', credentialId: 'cred-1', credentialName: 'deploy@prod',
          rootPath: '/var/www', mappings: [], excludedPaths: [],
        },
      },
    };
    const { deps, saveConfig } = makeDeps({ existingConfig, oldServers, oldBinding });
    const migrated = await migrateIfNeeded(deps);
    expect(migrated).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('skips migration when no old servers exist', async () => {
    const { deps, saveConfig } = makeDeps({ oldServers: [] });
    const migrated = await migrateIfNeeded(deps);
    expect(migrated).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('skips migration when no old binding exists', async () => {
    const { deps, saveConfig } = makeDeps({ oldServers, oldBinding: null });
    const migrated = await migrateIfNeeded(deps);
    expect(migrated).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('migrates even when existing config is empty (no servers)', async () => {
    const emptyConfig: ProjectConfig = { defaultServerId: '', servers: {} };
    const { deps, saveConfig } = makeDeps({ existingConfig: emptyConfig, oldServers, oldBinding });
    const migrated = await migrateIfNeeded(deps);
    expect(migrated).toBe(true);
    expect(saveConfig).toHaveBeenCalled();
  });

  it('migrates when existing fileferry.json is old binding format (UUID keys, no type field)', async () => {
    // Real old format: no defaultServerId, servers keyed by UUID with { mappings, excludedPaths }
    const oldFormatFile = {
      servers: {
        '9b3722bb-5a9b-4935-8e34-baa5ec8c09e3': {
          mappings: [{ localPath: '/', remotePath: '' }],
          excludedPaths: ['*.log'],
        },
      },
      uploadOnSave: true,
    } as unknown as ProjectConfig;
    const oldSrv: DeploymentServer[] = [
      { id: '9b3722bb-5a9b-4935-8e34-baa5ec8c09e3', name: 'MCRactive', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' },
    ];
    const oldBind: ProjectBinding = {
      defaultServerId: '',
      uploadOnSave: true,
      servers: {
        '9b3722bb-5a9b-4935-8e34-baa5ec8c09e3': {
          mappings: [{ localPath: '/', remotePath: '' }],
          excludedPaths: ['*.log'],
        },
      },
    };
    const { deps, saveConfig } = makeDeps({ existingConfig: oldFormatFile, oldServers: oldSrv, oldBinding: oldBind });
    const migrated = await migrateIfNeeded(deps);
    expect(migrated).toBe(true);
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: expect.objectContaining({
          MCRactive: expect.objectContaining({ id: '9b3722bb-5a9b-4935-8e34-baa5ec8c09e3', type: 'sftp' }),
        }),
      })
    );
  });
});
