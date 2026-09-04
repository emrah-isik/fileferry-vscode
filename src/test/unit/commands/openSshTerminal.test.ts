import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import type { Client } from 'ssh2';
import { openSshTerminal, OpenSshTerminalDependencies } from '../../../commands/openSshTerminal';
import { SshTerminal } from '../../../terminal/SshTerminal';
import { KeyboardInteractiveCoordinator } from '../../../ssh/connectProviders';
import { SshCredential, SshCredentialWithSecret } from '../../../models/SshCredential';
import { ProjectConfig, ProjectServer } from '../../../models/ProjectConfig';

// Feature 20, Q11: three entry points share one core — palette (active
// server, cwd = rootPath), Servers tree (that server, rootPath), Remote Files
// (active server, that directory). SFTP only.

const bastion: SshCredential = {
  id: 'cred-bastion', name: 'Bastion', host: 'bastion.example.com', port: 2222, username: 'jump', authMethod: 'password',
};
const chained: SshCredential = {
  id: 'cred-chained', name: 'Via Bastion', host: 'target.internal', port: 22, username: 'deploy',
  authMethod: 'password', jumpHosts: ['cred-bastion'],
};
const direct: SshCredential = {
  id: 'cred-direct', name: 'Direct', host: 'direct.example.com', port: 22, username: 'www', authMethod: 'key', privateKeyPath: '~/.ssh/id_ed25519',
};
const ftpCredential: SshCredential = {
  id: 'cred-ftp', name: 'FTP', host: 'ftp.example.com', port: 21, username: 'ftpuser', authMethod: 'password',
};

function server(overrides: Partial<ProjectServer>): ProjectServer {
  return {
    id: 'server-default', type: 'sftp', credentialId: 'cred-chained', credentialName: 'Via Bastion',
    rootPath: '/var/www/app', mappings: [], excludedPaths: [],
    ...overrides,
  };
}

const servers: Record<string, ProjectServer> = {
  Production: server({}),
  Staging: server({ id: 'server-staging', credentialId: 'cred-direct', credentialName: 'Direct', rootPath: '/srv/staging' }),
  Legacy: server({ id: 'server-ftp', type: 'ftp', credentialId: 'cred-ftp', credentialName: 'FTP', rootPath: '/htdocs' }),
  Secure: server({ id: 'server-ftps', type: 'ftps', credentialId: 'cred-ftp', credentialName: 'FTP', rootPath: '/htdocs' }),
};

/** Never authenticates; `end()` still emits 'close' so the pre-prompt timer is disposed. */
class NeverReadyClient extends EventEmitter {
  connect(): this { return this; }
  end(): this {
    setImmediate(() => this.emit('close'));
    return this;
  }
}

describe('openSshTerminal', () => {
  let config: ProjectConfig | null;
  let credentials: SshCredential[];
  let withSecretCalls: string[];
  let dependencies: OpenSshTerminalDependencies;
  const createTerminal = vscode.window.createTerminal as jest.Mock;
  const showErrorMessage = vscode.window.showErrorMessage as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    config = { defaultServerId: 'server-default', servers };
    credentials = [bastion, chained, direct, ftpCredential];
    withSecretCalls = [];
    dependencies = {
      configManager: {
        getConfig: async () => config,
        getServerById: async (id: string) => {
          const found = Object.entries(servers).find(([, candidate]) => candidate.id === id);
          return found ? { name: found[0], server: found[1] } : undefined;
        },
      },
      credentialManager: {
        getAll: async () => credentials,
        getWithSecret: async (id: string): Promise<SshCredentialWithSecret> => {
          withSecretCalls.push(id);
          const found = credentials.find((candidate) => candidate.id === id);
          if (!found) {
            throw new Error(`Credential not found: ${id}`);
          }
          return { ...found, password: 'secret' };
        },
      },
      terminal: {
        providers: { log: () => undefined, warn: () => undefined },
        coordinator: new KeyboardInteractiveCoordinator(),
        createClient: () => new NeverReadyClient() as unknown as Client,
      },
    };
  });

  function lastTerminalCall(): { name: string; pty: SshTerminal } {
    expect(createTerminal).toHaveBeenCalledTimes(1);
    return createTerminal.mock.calls[0][0];
  }

  it('palette: opens a pseudoterminal on the active server in its root path and shows it', async () => {
    await openSshTerminal({ serverId: null }, dependencies);

    const call = lastTerminalCall();
    expect(call.name).toBe('FileFerry: Production — /var/www/app');
    expect(call.pty).toBeInstanceOf(SshTerminal);
    expect(createTerminal.mock.results[0].value.show).toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('opens the tab with the route banner and only then loads the secret', async () => {
    await openSshTerminal({ serverId: null }, dependencies);
    const { pty } = lastTerminalCall();
    const writes: string[] = [];
    pty.onDidWrite((data) => writes.push(data));
    expect(withSecretCalls).toEqual([]);

    pty.open(undefined);
    await new Promise((resolve) => setImmediate(resolve));

    expect(writes[0]).toBe('Connecting to Production via local → jump@bastion.example.com:2222 → deploy@target.internal:22…\r\n');
    expect(withSecretCalls).toEqual(['cred-chained']);
    pty.close();
  });

  it('Servers tree: opens the given server even when it is not the default', async () => {
    await openSshTerminal({ serverId: 'server-staging' }, dependencies);

    expect(lastTerminalCall().name).toBe('FileFerry: Staging — /srv/staging');
  });

  it('Remote Files: starts in the given directory on the active server', async () => {
    await openSshTerminal({ serverId: null, remotePath: '/var/www/app/public/uploads' }, dependencies);

    expect(lastTerminalCall().name).toBe('FileFerry: Production — /var/www/app/public/uploads');
  });

  it.each([
    ['server-ftp', 'Legacy', 'FTP'],
    ['server-ftps', 'Secure', 'FTPS'],
  ])('refuses %s with a clear error — the terminal is SSH only', async (serverId, name, protocol) => {
    await openSshTerminal({ serverId }, dependencies);

    expect(createTerminal).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(
      `FileFerry: Open SSH Terminal needs an SFTP server — "${name}" uses ${protocol}.`
    );
  });

  it('explains when no server is configured', async () => {
    config = null;

    await openSshTerminal({ serverId: null }, dependencies);

    expect(createTerminal).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('No server configured'));
  });

  it('explains when the server no longer exists', async () => {
    await openSshTerminal({ serverId: 'server-gone' }, dependencies);

    expect(createTerminal).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Server not found'));
  });

  it('explains when the server\'s credential no longer exists', async () => {
    credentials = [bastion];

    await openSshTerminal({ serverId: null }, dependencies);

    expect(createTerminal).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('credential'));
  });
});
