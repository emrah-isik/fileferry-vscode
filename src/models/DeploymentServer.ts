export type ServerType = 'sftp' | 'ftp';

export interface DeploymentServer {
  id: string;
  name: string;
  type: ServerType;
  credentialId: string; // references SshCredential.id
  rootPath: string;     // remote root e.g. "/var/www"
}
