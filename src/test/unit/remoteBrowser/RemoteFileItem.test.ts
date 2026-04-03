import { RemoteFileItem, RemoteEntry, formatSize, formatDate } from '../../../remoteBrowser/RemoteFileItem';

const vscode = require('vscode');

describe('RemoteFileItem', () => {
  describe('directory entry', () => {
    const entry: RemoteEntry = {
      name: 'logs',
      type: 'd',
      size: 4096,
      modifyTime: 1710000000000,
      remotePath: '/var/log/logs',
    };

    it('has Collapsed collapsible state', () => {
      const item = new RemoteFileItem(entry);
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    });

    it('has contextValue of remoteDirectory', () => {
      const item = new RemoteFileItem(entry);
      expect(item.contextValue).toBe('remoteDirectory');
    });

    it('has resourceUri for theme-based folder icon', () => {
      const item = new RemoteFileItem(entry);
      expect(item.resourceUri).toBeDefined();
      expect(item.resourceUri!.fsPath).toContain('logs');
      // No manual iconPath — let the icon theme handle it
      expect(item.iconPath).toBeUndefined();
    });

    it('does not have a command', () => {
      const item = new RemoteFileItem(entry);
      expect(item.command).toBeUndefined();
    });

    it('uses the entry name as label', () => {
      const item = new RemoteFileItem(entry);
      expect(item.label).toBe('logs');
    });
  });

  describe('file entry', () => {
    const entry: RemoteEntry = {
      name: 'app.log',
      type: '-',
      size: 52428,
      modifyTime: 1710100000000,
      remotePath: '/var/log/app.log',
    };

    it('has None collapsible state', () => {
      const item = new RemoteFileItem(entry);
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });

    it('has contextValue of remoteFile', () => {
      const item = new RemoteFileItem(entry);
      expect(item.contextValue).toBe('remoteFile');
    });

    it('has resourceUri for theme-based file icon', () => {
      const item = new RemoteFileItem(entry);
      expect(item.resourceUri).toBeDefined();
      expect(item.resourceUri!.fsPath).toContain('app.log');
      expect(item.iconPath).toBeUndefined();
    });

    it('has a command to open the file', () => {
      const item = new RemoteFileItem(entry);
      expect(item.command).toEqual({
        command: 'fileferry.remoteBrowser.openFile',
        title: 'Open Remote File',
        arguments: [entry],
      });
    });
  });

  describe('symlink entry', () => {
    const entry: RemoteEntry = {
      name: 'current',
      type: 'l',
      size: 1024,
      modifyTime: 1710000000000,
      remotePath: '/var/log/current',
    };

    it('has None collapsible state', () => {
      const item = new RemoteFileItem(entry);
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });

    it('uses symlink icon', () => {
      const item = new RemoteFileItem(entry);
      expect(item.iconPath).toEqual(new vscode.ThemeIcon('file-symlink-file'));
    });

    it('has contextValue of remoteFile', () => {
      const item = new RemoteFileItem(entry);
      expect(item.contextValue).toBe('remoteFile');
    });
  });

  describe('description formatting', () => {
    it('shows size and date', () => {
      const entry: RemoteEntry = {
        name: 'app.log',
        type: '-',
        size: 52428,
        modifyTime: 1710100000000,
        remotePath: '/var/log/app.log',
      };
      const item = new RemoteFileItem(entry);
      expect(item.description).toContain(formatSize(52428));
    });
  });
});

describe('formatSize', () => {
  it('formats 0 bytes', () => {
    expect(formatSize(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatSize(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(1048576)).toBe('1.0 MB');
    expect(formatSize(5242880)).toBe('5.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatSize(1073741824)).toBe('1.0 GB');
  });
});

describe('formatDate', () => {
  it('formats a timestamp to a short date string', () => {
    const result = formatDate(1710000000000);
    // Should contain month and day at minimum
    expect(result).toMatch(/\w{3} \d{1,2}/);
  });

  it('returns empty string for 0', () => {
    expect(formatDate(0)).toBe('');
  });
});
