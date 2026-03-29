import * as vscode from 'vscode';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { FileFerryConfig, ServerConfig } from './types';

// Config is stored in .vscode/fileferry.json inside the workspace.
// This file is safe to commit to git — it contains NO secrets.
// Secrets (passwords, passphrases) are stored separately via SecretManager.

const CONFIG_FILENAME = 'fileferry.json';

export class ConfigManager {
  // Returns the URI of the config file inside the current workspace's .vscode folder.
  private getConfigUri(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder is open');
    }
    return vscode.Uri.file(
      path.join(folders[0].uri.fsPath, '.vscode', CONFIG_FILENAME)
    );
  }

  // Reads and parses the config file.
  // Returns an empty config if the file doesn't exist yet (first run).
  async loadConfig(): Promise<FileFerryConfig> {
    try {
      const uri = this.getConfigUri();
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Invalid JSON in fileferry.json');
      }

      return parsed as FileFerryConfig;
    } catch (err: unknown) {
      // If file doesn't exist, return a clean empty config
      if (this.isFileNotFound(err)) {
        return { servers: [] };
      }
      throw err;
    }
  }

  // Serializes and writes the config to disk.
  async saveConfig(config: FileFerryConfig): Promise<void> {
    const uri = this.getConfigUri();
    const text = JSON.stringify(config, null, 2);
    const bytes = new TextEncoder().encode(text);
    await vscode.workspace.fs.writeFile(uri, bytes);
  }

  // Adds a new server to the config. Generates a unique id automatically.
  async addServer(partial: Omit<ServerConfig, 'id'>): Promise<ServerConfig> {
    const config = await this.loadConfig();
    const server: ServerConfig = {
      id: crypto.randomUUID(),
      ...partial
    };
    config.servers.push(server);
    await this.saveConfig(config);
    return server;
  }

  // Removes a server by id and saves.
  async removeServer(id: string): Promise<void> {
    const config = await this.loadConfig();
    config.servers = config.servers.filter(s => s.id !== id);
    await this.saveConfig(config);
  }

  // Updates an existing server and saves.
  async updateServer(updated: ServerConfig): Promise<void> {
    const config = await this.loadConfig();
    const index = config.servers.findIndex(s => s.id === updated.id);
    if (index === -1) {
      throw new Error(`Server "${updated.id}" not found`);
    }
    config.servers[index] = updated;
    await this.saveConfig(config);
  }

  // Resolves a local absolute file path to its remote path using the server's mappings.
  //
  // Algorithm:
  // 1. Strip the workspaceRoot prefix from localAbsPath to get a relative path
  // 2. Check if the relative path matches any excludedPaths pattern (glob)
  // 3. Find the most specific mapping (longest localPath prefix match)
  // 4. Return remotePath + remaining suffix
  //
  // Returns null if the file is excluded or no mapping matches.
  resolveRemotePath(
    server: ServerConfig,
    localAbsPath: string,
    workspaceRoot: string
  ): string | null {
    // Normalize paths to use forward slashes
    const normalizedAbs = localAbsPath.replace(/\\/g, '/');
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/');

    // Get the path relative to workspace root
    const relativePath = normalizedAbs.startsWith(normalizedRoot)
      ? normalizedAbs.slice(normalizedRoot.length)
      : normalizedAbs;

    // Check excluded patterns — if any match, skip this file
    const relativeNoLeadingSlash = relativePath.replace(/^\//, '');
    for (const pattern of server.excludedPaths) {
      if (minimatch(relativeNoLeadingSlash, pattern, { matchBase: true })) {
        return null;
      }
      // Also check each path segment (e.g. "node_modules" should match "node_modules/lodash/index.js")
      const segments = relativeNoLeadingSlash.split('/');
      if (segments.some(seg => minimatch(seg, pattern))) {
        return null;
      }
    }

    // Sort mappings by localPath length descending — longest (most specific) wins
    const sortedMappings = [...server.mappings].sort(
      (a, b) => b.localPath.length - a.localPath.length
    );

    for (const mapping of sortedMappings) {
      const normalizedLocal = mapping.localPath === '/'
        ? ''
        : mapping.localPath.replace(/\\/g, '/').replace(/\/$/, '');

      if (relativePath.startsWith(normalizedLocal + '/') || normalizedLocal === '') {
        const suffix = relativePath.slice(normalizedLocal.length);
        const remotePath = mapping.remotePath.replace(/\/$/, '') + suffix;
        return remotePath;
      }
    }

    return null;
  }

  private isFileNotFound(err: unknown): boolean {
    if (typeof err === 'object' && err !== null) {
      const code = (err as Record<string, unknown>).code;
      return code === 'FileNotFound' || code === 'ENOENT';
    }
    return false;
  }
}
