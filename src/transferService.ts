export interface FileEntry {
  name: string;
  type: 'd' | '-' | 'l';
  size: number;
  modifyTime: number;
}

export interface TransferService {
  readonly connected: boolean;

  connect(
    server: unknown,
    credentials: { password?: string; passphrase?: string },
    options?: {
      hostVerifier?: (key: Buffer | string) => boolean | Promise<boolean>;
      keyboardInteractiveHandler?: (prompts: Array<{ prompt: string; echo: boolean }>) => Promise<string[]>;
    }
  ): Promise<void>;

  uploadFile(localPath: string, remotePath: string): Promise<void>;
  get(remotePath: string): Promise<Buffer>;
  listDirectory(remotePath: string): Promise<Array<{ name: string; type: string }>>;
  listDirectoryDetailed(remotePath: string): Promise<FileEntry[]>;
  resolveRemotePath(remotePath: string): Promise<string>;
  statType(remotePath: string): Promise<'d' | '-' | null>;
  stat(remotePath: string): Promise<{ mtime: Date } | null>;
  deleteFile(remotePath: string): Promise<void>;
  deleteDirectory(remotePath: string): Promise<void>;
  chmod(remotePath: string, mode: number): Promise<void>;
  disconnect(): Promise<void>;
}
