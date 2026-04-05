import {
  validateSshCredential,
  validateDeploymentServer,
  validateMappings,
} from '../../utils/validation';
import { SshCredential } from '../../models/SshCredential';
import { DeploymentServer } from '../../models/DeploymentServer';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const validCredential = {
  name: 'Production SSH',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password' as const,
  password: 'secret',
};

const existingCredentials: SshCredential[] = [
  { id: 'cred-existing', name: 'Existing', host: 'other.com', port: 22, username: 'user', authMethod: 'password' },
];

const existingServers: DeploymentServer[] = [
  { id: 'srv-existing', name: 'Existing Server', type: 'sftp', credentialId: 'cred-1', rootPath: '/var/www' },
];

const validServer = {
  name: 'Production',
  type: 'sftp' as const,
  credentialId: 'cred-existing',  // matches existingCredentials fixture
  rootPath: '/var/www',
};

const validMappings = [{ localPath: '/src', remotePath: 'www/src' }];

// ─── validateSshCredential ────────────────────────────────────────────────────

describe('validateSshCredential', () => {
  it('accepts valid hostname', () => {
    expect(validateSshCredential({ ...validCredential, host: 'example.com' }, [])).toHaveLength(0);
  });

  it('accepts valid IPv4', () => {
    expect(validateSshCredential({ ...validCredential, host: '192.168.1.1' }, [])).toHaveLength(0);
  });

  it('accepts valid IPv6', () => {
    expect(validateSshCredential({ ...validCredential, host: '[::1]' }, [])).toHaveLength(0);
  });

  it('rejects empty name', () => {
    const errors = validateSshCredential({ ...validCredential, name: '' }, []);
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects name shorter than 3 characters', () => {
    const errors = validateSshCredential({ ...validCredential, name: 'Ab' }, []);
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects name longer than 50 chars', () => {
    const errors = validateSshCredential({ ...validCredential, name: 'a'.repeat(51) }, []);
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects duplicate name (against existing credentials list)', () => {
    const errors = validateSshCredential(
      { ...validCredential, name: 'Existing' },
      existingCredentials
    );
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects invalid port — 0', () => {
    const errors = validateSshCredential({ ...validCredential, port: 0 }, []);
    expect(errors.some(e => e.field === 'port')).toBe(true);
  });

  it('rejects invalid port — 65536', () => {
    const errors = validateSshCredential({ ...validCredential, port: 65536 }, []);
    expect(errors.some(e => e.field === 'port')).toBe(true);
  });

  it('rejects port that is not an integer', () => {
    const errors = validateSshCredential({ ...validCredential, port: 22.5 }, []);
    expect(errors.some(e => e.field === 'port')).toBe(true);
  });

  it('rejects username with spaces', () => {
    const errors = validateSshCredential({ ...validCredential, username: 'deploy user' }, []);
    expect(errors.some(e => e.field === 'username')).toBe(true);
  });

  it('rejects username longer than 64 characters', () => {
    const errors = validateSshCredential({ ...validCredential, username: 'a'.repeat(65) }, []);
    expect(errors.some(e => e.field === 'username')).toBe(true);
  });

  it('requires password when authMethod is password (new credential)', () => {
    const errors = validateSshCredential(
      { ...validCredential, password: '' },
      [],
      undefined   // no currentId = new credential
    );
    expect(errors.some(e => e.field === 'password')).toBe(true);
  });

  it('does not require password when editing an existing credential', () => {
    const errors = validateSshCredential(
      { ...validCredential, password: '' },
      [],
      'cred-1'    // currentId present = editing
    );
    expect(errors.some(e => e.field === 'password')).toBe(false);
  });

  it('requires privateKeyPath when authMethod is key', () => {
    const errors = validateSshCredential(
      { ...validCredential, authMethod: 'key', privateKeyPath: '' },
      []
    );
    expect(errors.some(e => e.field === 'privateKeyPath')).toBe(true);
  });

  it('rejects privateKeyPath that does not start with / or ~', () => {
    const errors = validateSshCredential(
      { ...validCredential, authMethod: 'key', privateKeyPath: 'relative/path/id_rsa' },
      []
    );
    expect(errors.some(e => e.field === 'privateKeyPath')).toBe(true);
  });

  it('accepts privateKeyPath starting with ~', () => {
    const errors = validateSshCredential(
      { ...validCredential, authMethod: 'key', privateKeyPath: '~/.ssh/id_rsa' },
      []
    );
    expect(errors.some(e => e.field === 'privateKeyPath')).toBe(false);
  });

  it('accepts privateKeyPath starting with /', () => {
    const errors = validateSshCredential(
      { ...validCredential, authMethod: 'key', privateKeyPath: '/home/user/.ssh/id_rsa' },
      []
    );
    expect(errors.some(e => e.field === 'privateKeyPath')).toBe(false);
  });

  it('returns no error for agent auth with no extra fields', () => {
    const errors = validateSshCredential(
      { ...validCredential, authMethod: 'agent', password: undefined },
      []
    );
    expect(errors).toHaveLength(0);
  });

  it('returns no error for keyboard-interactive auth with no extra fields', () => {
    const errors = validateSshCredential(
      { ...validCredential, authMethod: 'keyboard-interactive', password: undefined },
      []
    );
    expect(errors).toHaveLength(0);
  });

  it('returns multiple errors for multiple invalid fields simultaneously', () => {
    const errors = validateSshCredential(
      { name: '', host: '', port: 0, username: '', authMethod: 'password', password: '' },
      []
    );
    expect(errors.length).toBeGreaterThan(1);
  });
});

// ─── validateDeploymentServer ─────────────────────────────────────────────────

describe('validateDeploymentServer', () => {
  it('requires name', () => {
    const errors = validateDeploymentServer({ ...validServer, name: '' }, [], existingCredentials);
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects name shorter than 3 characters', () => {
    const errors = validateDeploymentServer({ ...validServer, name: 'Ab' }, [], existingCredentials);
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects name longer than 50 characters', () => {
    const errors = validateDeploymentServer({ ...validServer, name: 'a'.repeat(51) }, [], existingCredentials);
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('requires unique name', () => {
    const errors = validateDeploymentServer(
      { ...validServer, name: 'Existing Server' },
      existingServers,
      existingCredentials
    );
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('requires type', () => {
    const errors = validateDeploymentServer(
      { ...validServer, type: undefined as any },
      [],
      existingCredentials
    );
    expect(errors.some(e => e.field === 'type')).toBe(true);
  });

  it('requires credentialId that exists in credentials list', () => {
    const errors = validateDeploymentServer({ ...validServer, credentialId: 'ghost' }, [], []);
    expect(errors.some(e => e.field === 'credentialId')).toBe(true);
  });

  it('requires rootPath starting with /', () => {
    const errors = validateDeploymentServer(
      { ...validServer, rootPath: 'var/www' },
      [],
      existingCredentials
    );
    expect(errors.some(e => e.field === 'rootPath')).toBe(true);
  });

  it('returns no errors for a valid server', () => {
    expect(validateDeploymentServer(validServer, [], existingCredentials)).toHaveLength(0);
  });
});

// ─── validateMappings ─────────────────────────────────────────────────────────

describe('validateMappings', () => {
  it('rejects empty mappings array', () => {
    const errors = validateMappings([], []);
    expect(errors.some(e => e.field === 'mappings')).toBe(true);
  });

  it('rejects duplicate localPath values', () => {
    const errors = validateMappings(
      [{ localPath: '/', remotePath: '/var/www' }, { localPath: '/', remotePath: '/var/www/v2' }],
      []
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects localPath not starting with /', () => {
    const errors = validateMappings([{ localPath: 'src', remotePath: '/var/www' }], []);
    expect(errors.some(e => e.field.includes('localPath'))).toBe(true);
  });

  it('accepts relative remotePath (no leading / required)', () => {
    const errors = validateMappings([{ localPath: '/', remotePath: 'html' }], []);
    expect(errors.some(e => e.field.includes('remotePath'))).toBe(false);
  });

  it('accepts empty remotePath (maps directly to root)', () => {
    const errors = validateMappings([{ localPath: '/', remotePath: '' }], []);
    expect(errors.some(e => e.field.includes('remotePath'))).toBe(false);
  });

  it('rejects empty excluded path entry', () => {
    const errors = validateMappings(validMappings, ['']);
    expect(errors.some(e => e.field.includes('excludedPaths'))).toBe(true);
  });

  it('rejects duplicate excluded paths', () => {
    const errors = validateMappings(validMappings, ['node_modules', 'node_modules']);
    expect(errors.some(e => e.field.includes('excludedPaths'))).toBe(true);
  });

  it('rejects invalid glob pattern (bare brackets)', () => {
    const errors = validateMappings(validMappings, ['node_[']);
    expect(errors.some(e => e.field.includes('excludedPaths'))).toBe(true);
  });

  it('returns no errors for valid mappings and excluded paths', () => {
    expect(validateMappings(validMappings, ['node_modules', '*.log'])).toHaveLength(0);
  });
});
