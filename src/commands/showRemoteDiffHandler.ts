import { showRemoteDiff } from './showRemoteDiff';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { normalizeCommandArgs } from '../utils/normalizeCommandArgs';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
}

export function makeShowRemoteDiffHandler(dependencies: Dependencies) {
  return (...args: unknown[]) => {
    const { resource } = normalizeCommandArgs(...args);
    return showRemoteDiff(resource, dependencies);
  };
}
