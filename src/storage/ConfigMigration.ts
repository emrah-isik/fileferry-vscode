import { DeploymentServer } from '../models/DeploymentServer';
import { ProjectBinding } from '../models/ProjectBinding';
import { ProjectConfig, ProjectServer } from '../models/ProjectConfig';
import { SshCredential } from '../models/SshCredential';

export interface MigrationDeps {
  getExistingConfig: () => Promise<ProjectConfig | null>;
  readOldServers: () => Promise<DeploymentServer[]>;
  readOldBinding: () => Promise<ProjectBinding | null>;
  getCredentials: () => Promise<SshCredential[]>;
  saveConfig: (config: ProjectConfig) => Promise<void>;
}

function isNewFormatConfig(config: ProjectConfig): boolean {
  const entries = Object.values(config.servers);
  if (entries.length === 0) { return false; }
  // New format has `type` on every server entry; old binding format has `mappings` but no `type`
  return entries.every((s: any) => typeof s.type === 'string');
}

export async function migrateIfNeeded(deps: MigrationDeps): Promise<boolean> {
  const existing = await deps.getExistingConfig();
  if (existing && isNewFormatConfig(existing)) {
    return false;
  }

  const oldServers = await deps.readOldServers();
  if (oldServers.length === 0) {
    return false;
  }

  const oldBinding = await deps.readOldBinding();
  if (!oldBinding) {
    return false;
  }

  const credentials = await deps.getCredentials();
  const config = migrateToProjectConfig(oldServers, oldBinding, credentials);
  await deps.saveConfig(config);
  return true;
}

export function migrateToProjectConfig(
  servers: DeploymentServer[],
  binding: ProjectBinding | null,
  credentials: SshCredential[]
): ProjectConfig {
  if (!binding) {
    return { defaultServerId: '', servers: {} };
  }

  const credentialMap = new Map(credentials.map(c => [c.id, c]));
  const serverMap = new Map(servers.map(s => [s.id, s]));

  const config: ProjectConfig = {
    defaultServerId: '',
    servers: {},
  };

  if (binding.uploadOnSave !== undefined) {
    config.uploadOnSave = binding.uploadOnSave;
  }

  const usedNames = new Set<string>();

  for (const [serverId, serverBinding] of Object.entries(binding.servers)) {
    const server = serverMap.get(serverId);
    if (!server) {
      continue;
    }

    let name = server.name;
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${name}-${suffix}`)) {
        suffix++;
      }
      name = `${name}-${suffix}`;
    }
    usedNames.add(name);

    const credential = credentialMap.get(server.credentialId);

    const projectServer: ProjectServer = {
      id: server.id,
      type: server.type,
      credentialId: server.credentialId,
      credentialName: credential?.name ?? '',
      rootPath: serverBinding.rootPathOverride ?? server.rootPath,
      mappings: [...serverBinding.mappings],
      excludedPaths: [...serverBinding.excludedPaths],
    };

    config.servers[name] = projectServer;

    if (serverId === binding.defaultServerId) {
      config.defaultServerId = serverId;
    }
  }

  return config;
}
