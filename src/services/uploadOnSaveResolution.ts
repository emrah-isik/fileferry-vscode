import type { ProjectConfig, ProjectServer } from '../models/ProjectConfig';

export interface UploadOnSaveResolution {
  enabled: boolean;
  /** `'server'` when the server's own `uploadOnSave` decided; `'project'` when it inherited the toggle. */
  source: 'server' | 'project';
}

/**
 * Feature 35a — the one place the upload-on-save rule lives: a server's own
 * `uploadOnSave` wins over the project toggle; an absent field inherits it.
 * `server` is undefined when no default server resolves (then only the
 * project toggle can speak, and the caller's no-server handling takes over).
 */
export function resolveUploadOnSave(
  config: Pick<ProjectConfig, 'uploadOnSave'>,
  server: Pick<ProjectServer, 'uploadOnSave'> | undefined
): UploadOnSaveResolution {
  if (server?.uploadOnSave !== undefined) {
    return { enabled: server.uploadOnSave, source: 'server' };
  }
  return { enabled: config.uploadOnSave === true, source: 'project' };
}

/** Notification for the project-level toggle command: honest when the default server overrides it. */
export function uploadOnSaveToggleMessage(
  newProjectValue: boolean,
  defaultServerName: string | undefined,
  resolution: UploadOnSaveResolution
): string {
  const verb = newProjectValue ? 'enabled' : 'disabled';
  if (resolution.source !== 'server') {
    return `FileFerry: Upload on save ${verb}.`;
  }
  const serverValue = resolution.enabled ? 'ON' : 'OFF';
  return `FileFerry: Upload on save ${verb} for the project — but "${defaultServerName ?? 'the default server'}" sets it to ${serverValue} itself (Deployment Settings → Connection).`;
}
