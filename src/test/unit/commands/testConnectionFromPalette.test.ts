import * as vscode from 'vscode';
import { makeTestConnectionFromPaletteHandler } from '../../../commands/testConnectionFromPalette';
import type { ProjectConfigManager } from '../../../storage/ProjectConfigManager';

// Polish 2026-11: "FileFerry: Test Connection" in the Command Palette. The
// Servers-tree command needs a server item, so the palette entry picks the
// server first (default server listed first) and hands the id to it.

const mockConfigManager = {
  getConfig: jest.fn(),
} as unknown as ProjectConfigManager;

const productionServer = { id: 'srv-prod', type: 'sftp', rootPath: '/var/www/prod' };
const stagingServer = { id: 'srv-staging', type: 'sftp', rootPath: '/var/www/staging' };

describe('makeTestConnectionFromPaletteHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
  });

  it('warns and does nothing when no servers are configured', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue(null);
    const handler = makeTestConnectionFromPaletteHandler({ configManager: mockConfigManager });

    await handler();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No servers configured')
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('warns when the config exists but has an empty server list', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({ defaultServerId: '', servers: {} });
    const handler = makeTestConnectionFromPaletteHandler({ configManager: mockConfigManager });

    await handler();

    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('lists every server with the default first and marked, then tests the picked one', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
      defaultServerId: 'srv-staging',
      servers: { Production: productionServer, Staging: stagingServer },
    });
    (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: any[]) => items[1]);
    const handler = makeTestConnectionFromPaletteHandler({ configManager: mockConfigManager });

    await handler();

    const items = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
    expect(items.map((item: any) => item.label)).toEqual(['Staging', 'Production']);
    expect(items[0].description).toContain('default');
    expect(items[1].description).toBe('/var/www/prod');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.servers.testConnection', 'srv-prod');
  });

  it('skips the pick and tests directly when there is exactly one server', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
      defaultServerId: 'srv-prod',
      servers: { Production: productionServer },
    });
    const handler = makeTestConnectionFromPaletteHandler({ configManager: mockConfigManager });

    await handler();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('fileferry.servers.testConnection', 'srv-prod');
  });

  it('does nothing when the pick is dismissed', async () => {
    (mockConfigManager.getConfig as jest.Mock).mockResolvedValue({
      defaultServerId: 'srv-prod',
      servers: { Production: productionServer, Staging: stagingServer },
    });
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
    const handler = makeTestConnectionFromPaletteHandler({ configManager: mockConfigManager });

    await handler();

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
