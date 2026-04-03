import { ServerItem, ServerItemData } from '../../../remoteBrowser/ServerItem';
import { DeploymentServer } from '../../../models/DeploymentServer';
import { SshCredential } from '../../../models/SshCredential';

const vscode = require('vscode');

const fakeServer: DeploymentServer = {
  id: 'server-1',
  name: 'Production',
  type: 'sftp',
  credentialId: 'cred-1',
  rootPath: '/var/www',
};

const fakeCredential: SshCredential = {
  id: 'cred-1',
  name: 'Deploy Key',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
};

describe('ServerItem', () => {
  describe('active (default) server', () => {
    const data: ServerItemData = {
      server: fakeServer,
      credential: fakeCredential,
      isDefault: true,
    };

    it('shows filled circle icon', () => {
      const item = new ServerItem(data);
      expect(item.iconPath).toEqual(new vscode.ThemeIcon('circle-filled'));
    });

    it('has contextValue server-active', () => {
      const item = new ServerItem(data);
      expect(item.contextValue).toBe('server-active');
    });

    it('uses server name as label', () => {
      const item = new ServerItem(data);
      expect(item.label).toBe('Production');
    });
  });

  describe('inactive server', () => {
    const data: ServerItemData = {
      server: fakeServer,
      credential: fakeCredential,
      isDefault: false,
    };

    it('shows outline circle icon', () => {
      const item = new ServerItem(data);
      expect(item.iconPath).toEqual(new vscode.ThemeIcon('circle-outline'));
    });

    it('has contextValue server-inactive', () => {
      const item = new ServerItem(data);
      expect(item.contextValue).toBe('server-inactive');
    });
  });

  describe('description', () => {
    it('shows user@host:rootPath when credential exists', () => {
      const data: ServerItemData = {
        server: fakeServer,
        credential: fakeCredential,
        isDefault: false,
      };
      const item = new ServerItem(data);
      expect(item.description).toBe('deploy@example.com:/var/www');
    });

    it('shows "credential missing" when credential is undefined', () => {
      const data: ServerItemData = {
        server: fakeServer,
        credential: undefined,
        isDefault: false,
      };
      const item = new ServerItem(data);
      expect(item.description).toBe('credential missing');
    });
  });

  describe('command', () => {
    it('has setDefault command with server id', () => {
      const data: ServerItemData = {
        server: fakeServer,
        credential: fakeCredential,
        isDefault: false,
      };
      const item = new ServerItem(data);
      expect(item.command).toEqual({
        command: 'fileferry.servers.setDefault',
        title: 'Set as Default',
        arguments: ['server-1'],
      });
    });
  });

  describe('collapsibleState', () => {
    it('is None (leaf item)', () => {
      const data: ServerItemData = {
        server: fakeServer,
        credential: fakeCredential,
        isDefault: false,
      };
      const item = new ServerItem(data);
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });
  });
});
