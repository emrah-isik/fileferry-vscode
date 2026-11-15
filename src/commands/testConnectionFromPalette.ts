import * as vscode from 'vscode';
import type { ProjectConfigManager } from '../storage/ProjectConfigManager';

interface Dependencies {
  configManager: ProjectConfigManager;
}

export function makeTestConnectionFromPaletteHandler(dependencies: Dependencies) {
  return async (): Promise<void> => {
    const config = await dependencies.configManager.getConfig();

    const serverEntries = config ? Object.entries(config.servers) : [];

    if (!config || serverEntries.length === 0) {
      vscode.window.showWarningMessage(
        'FileFerry: No servers configured'
      );
      return;
    }

    const items = serverEntries.map(([name, server]) => ({
      label: name,
      description: server.id === config.defaultServerId ? '(current default)' : server.rootPath,
      id: server.id,
    }));

    items.sort((a, b) => {
      if (a.id === config.defaultServerId) return -1;
      if (b.id === config.defaultServerId) return 1;

      return 0;
    });

    let serverId = items[0].id;

    if (serverEntries.length > 1) {
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'FileFerry: Select deployment server to test',
      });

      if (!picked) {
        return;
      }

      serverId = picked.id;
    }

    await vscode.commands.executeCommand('fileferry.servers.testConnection', serverId);
  };

}
