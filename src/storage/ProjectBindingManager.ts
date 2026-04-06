import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { ProjectBinding, ServerBinding, PathMapping } from '../models/ProjectBinding';

export interface BindingValidationError {
  field: 'mappings' | 'excludedPaths';
  message: string;
}

export class ProjectBindingManager {
  private getBindingPath(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace open');
    }
    return path.join(folders[0].uri.fsPath, '.vscode', 'fileferry.json');
  }

  async getBinding(): Promise<ProjectBinding | null> {
    try {
      const raw = await fs.readFile(this.getBindingPath(), 'utf-8');
      return JSON.parse(raw) as ProjectBinding;
    } catch {
      return null;
    }
  }

  async saveBinding(binding: ProjectBinding): Promise<void> {
    const filePath = this.getBindingPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(binding, null, 2), 'utf-8');
  }

  async setDefaultServer(serverId: string): Promise<void> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    binding.defaultServerId = serverId;
    await this.saveBinding(binding);
  }

  async setServerBinding(serverId: string, serverBinding: ServerBinding): Promise<void> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    binding.servers[serverId] = serverBinding;
    await this.saveBinding(binding);
  }

  async removeServerBinding(serverId: string): Promise<void> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    delete binding.servers[serverId];
    await this.saveBinding(binding);
  }

  async addMapping(serverId: string, mapping: PathMapping): Promise<void> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    const sb = binding.servers[serverId] ?? { mappings: [], excludedPaths: [] };
    sb.mappings = [...sb.mappings, mapping];
    binding.servers[serverId] = sb;
    await this.saveBinding(binding);
  }

  async removeMapping(serverId: string, index: number): Promise<void> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    const sb = binding.servers[serverId] ?? { mappings: [], excludedPaths: [] };
    sb.mappings = sb.mappings.filter((_, i) => i !== index);
    binding.servers[serverId] = sb;
    await this.saveBinding(binding);
  }

  async updateMapping(serverId: string, index: number, mapping: PathMapping): Promise<void> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    const sb = binding.servers[serverId] ?? { mappings: [], excludedPaths: [] };
    sb.mappings = sb.mappings.map((m, i) => (i === index ? mapping : m));
    binding.servers[serverId] = sb;
    await this.saveBinding(binding);
  }

  async addExcludedPath(serverId: string, pattern: string): Promise<void> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    const sb = binding.servers[serverId] ?? { mappings: [], excludedPaths: [] };
    sb.excludedPaths = [...sb.excludedPaths, pattern];
    binding.servers[serverId] = sb;
    await this.saveBinding(binding);
  }

  async removeExcludedPath(serverId: string, pattern: string): Promise<void> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    const sb = binding.servers[serverId] ?? { mappings: [], excludedPaths: [] };
    sb.excludedPaths = sb.excludedPaths.filter(p => p !== pattern);
    binding.servers[serverId] = sb;
    await this.saveBinding(binding);
  }

  async toggleUploadOnSave(): Promise<boolean> {
    const binding = (await this.getBinding()) ?? { defaultServerId: '', servers: {} };
    binding.uploadOnSave = !binding.uploadOnSave;
    await this.saveBinding(binding);
    return binding.uploadOnSave;
  }

  validateBinding(serverBinding: ServerBinding): BindingValidationError[] {
    const errors: BindingValidationError[] = [];

    if (serverBinding.mappings.length === 0) {
      errors.push({ field: 'mappings', message: 'At least one path mapping is required' });
    } else {
      const localPaths = serverBinding.mappings.map(m => m.localPath);
      const duplicates = localPaths.filter((p, i) => localPaths.indexOf(p) !== i);
      if (duplicates.length > 0) {
        errors.push({ field: 'mappings', message: `Duplicate local paths: ${[...new Set(duplicates)].join(', ')}` });
      }
    }

    const invalidExclusions = serverBinding.excludedPaths.filter(p => !p.trim());
    if (invalidExclusions.length > 0) {
      errors.push({ field: 'excludedPaths', message: 'Excluded path patterns must not be empty' });
    }

    return errors;
  }

  resolveRemotePath(serverBinding: ServerBinding, localRelativePath: string): string | null {
    // Check excluded paths first
    for (const excluded of serverBinding.excludedPaths) {
      if (minimatch(localRelativePath, `${excluded}/**`) || localRelativePath.startsWith(`${excluded}/`) || localRelativePath === excluded) {
        return null;
      }
    }

    // Find longest matching prefix
    let bestMapping: { localPath: string; remotePath: string } | null = null;
    let bestLength = -1;

    for (const mapping of serverBinding.mappings) {
      const local = mapping.localPath === '/' ? '' : mapping.localPath.replace(/^\//, '');
      const matches = local === '' || localRelativePath === local || localRelativePath.startsWith(`${local}/`);
      if (matches && local.length > bestLength) {
        bestLength = local.length;
        bestMapping = mapping;
      }
    }

    if (!bestMapping) {
      return null;
    }

    const local = bestMapping.localPath === '/' ? '' : bestMapping.localPath.replace(/^\//, '');
    const relative = local === '' ? localRelativePath : localRelativePath.slice(local.length + 1);
    const remote = bestMapping.remotePath.replace(/\/$/, '');
    return relative ? `${remote}/${relative}` : remote;
  }
}
