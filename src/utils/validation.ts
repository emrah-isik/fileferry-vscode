import { SshCredential, SshCredentialWithSecret } from '../models/SshCredential';
import { ProjectServer } from '../models/ProjectConfig';

export interface ValidationError {
  field: string;
  message: string;
}

// Accepts DNS names, bare IPv4, and bracketed IPv6 — intentionally permissive
// (SSH will reject at connect time if wrong, no need to duplicate that logic here)
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$|^\d{1,3}(\.\d{1,3}){3}$|^\[.*\]$/;

export function validateSshCredential(
  credential: Partial<SshCredentialWithSecret>,
  existingCredentials: SshCredential[],
  currentId?: string   // present when editing — excludes self from uniqueness check and relaxes password requirement
): ValidationError[] {
  const errors: ValidationError[] = [];
  const isNew = !currentId;

  if (!credential.name?.trim()) {
    errors.push({ field: 'name', message: 'Name is required' });
  } else if (credential.name.trim().length < 3) {
    errors.push({ field: 'name', message: 'Name must be at least 3 characters' });
  } else if (credential.name.trim().length > 50) {
    errors.push({ field: 'name', message: 'Name must be 50 characters or fewer' });
  } else {
    const duplicate = existingCredentials.find(
      c => c.name.toLowerCase() === credential.name!.trim().toLowerCase() && c.id !== currentId
    );
    if (duplicate) {
      errors.push({ field: 'name', message: `Name "${credential.name.trim()}" is already in use` });
    }
  }

  if (!credential.host?.trim()) {
    errors.push({ field: 'host', message: 'Host is required' });
  } else if (!HOSTNAME_RE.test(credential.host.trim())) {
    errors.push({ field: 'host', message: 'Host must be a valid hostname or IP address' });
  }

  const port = credential.port;
  if (port === undefined || port === null) {
    errors.push({ field: 'port', message: 'Port is required' });
  } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push({ field: 'port', message: 'Port must be an integer between 1 and 65535' });
  }

  if (!credential.username?.trim()) {
    errors.push({ field: 'username', message: 'Username is required' });
  } else if (/\s/.test(credential.username)) {
    errors.push({ field: 'username', message: 'Username must not contain spaces' });
  } else if (credential.username.trim().length > 64) {
    errors.push({ field: 'username', message: 'Username must be 64 characters or fewer' });
  }

  if (credential.authMethod === 'password') {
    // Only require password for new credentials — edits can leave it blank to keep existing
    if (isNew && !credential.password?.trim()) {
      errors.push({ field: 'password', message: 'Password is required for password authentication' });
    }
  } else if (credential.authMethod === 'key') {
    if (!credential.privateKeyPath?.trim()) {
      errors.push({ field: 'privateKeyPath', message: 'Private key path is required for key authentication' });
    } else if (!/^(\/|~)/.test(credential.privateKeyPath.trim())) {
      errors.push({ field: 'privateKeyPath', message: 'Private key path must start with / or ~' });
    }
  }

  return errors;
}

export function validateProjectServer(
  name: string,
  server: Partial<ProjectServer>,
  existingServerNames: string[],
  existingCredentials: SshCredential[],
  currentName?: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  const trimmedName = name.trim();
  if (!trimmedName) {
    errors.push({ field: 'name', message: 'Name is required' });
  } else if (trimmedName.length < 3) {
    errors.push({ field: 'name', message: 'Name must be at least 3 characters' });
  } else if (trimmedName.length > 50) {
    errors.push({ field: 'name', message: 'Name must be 50 characters or fewer' });
  } else {
    const duplicate = existingServerNames.find(
      n => n.toLowerCase() === trimmedName.toLowerCase() && n.toLowerCase() !== currentName?.toLowerCase()
    );
    if (duplicate) {
      errors.push({ field: 'name', message: `Name "${trimmedName}" is already in use` });
    }
  }

  if (!server.type) {
    errors.push({ field: 'type', message: 'Server type is required' });
  }

  if (!server.credentialId) {
    errors.push({ field: 'credentialId', message: 'SSH Credential must be selected' });
  } else if (!existingCredentials.some(c => c.id === server.credentialId)) {
    errors.push({ field: 'credentialId', message: 'Selected credential no longer exists' });
  }

  if (!server.rootPath?.trim()) {
    errors.push({ field: 'rootPath', message: 'Root path is required' });
  } else if (!server.rootPath.trim().startsWith('/')) {
    errors.push({ field: 'rootPath', message: 'Root path must start with /' });
  }

  return errors;
}

export function validateMappings(
  mappings: Array<{ localPath: string; remotePath: string }>,
  excludedPaths: string[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (mappings.length === 0) {
    errors.push({ field: 'mappings', message: 'At least one path mapping is required' });
  }

  const seenLocal = new Set<string>();
  for (let i = 0; i < mappings.length; i++) {
    const { localPath } = mappings[i];
    if (!localPath.trim().startsWith('/')) {
      errors.push({ field: `mappings[${i}].localPath`, message: 'Local path must start with /' });
    } else if (seenLocal.has(localPath.trim())) {
      errors.push({ field: `mappings[${i}].localPath`, message: 'Duplicate local path' });
    } else {
      seenLocal.add(localPath.trim());
    }
    // remotePath is relative to the server root — empty string or a subdirectory name
    // like 'html' or 'public_html' are all valid.
  }

  const seenExcluded = new Set<string>();
  for (let i = 0; i < excludedPaths.length; i++) {
    const p = excludedPaths[i].trim();
    if (!p) {
      errors.push({ field: `excludedPaths[${i}]`, message: 'Excluded path must not be empty' });
    } else if (seenExcluded.has(p)) {
      errors.push({ field: `excludedPaths[${i}]`, message: 'Duplicate excluded path' });
    } else if (/\[[^\]]*$/.test(p) || /^[^\[]*\]/.test(p)) {
      errors.push({ field: `excludedPaths[${i}]`, message: 'Invalid glob pattern: unclosed bracket' });
    } else {
      seenExcluded.add(p);
    }
  }

  return errors;
}
