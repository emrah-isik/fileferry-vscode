import { createHash } from 'crypto';
import type { ExtensionContext } from 'vscode';

// Named, per-project hook secrets (#27b). Values live in the OS keychain via
// VS Code SecretStorage — mirroring CredentialManager — under
// `fileferry.hookSecret.<scope>.<NAME>`. SecretStorage is extension-global, so
// the scope segment (a hash of the workspace root path) keeps two projects'
// same-named secrets apart. Moving the project folder changes the scope and
// orphans its secrets; the UI treats that like a fresh clone: re-enter them.
//
// SecretStorage cannot enumerate keys, so the list of names is kept as an
// index in workspaceState. Names are not secret — only values are — and
// workspaceState is lost in the same cases the scope hash changes, so the two
// stores stay consistent.

// A secret name doubles as an environment variable name when a local hook is
// run (see HookRunner), so it must be valid as one.
const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const NAMES_INDEX_KEY = 'fileferry.hookSecretNames';

export function isValidHookSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

export class HookSecretManager {
  private readonly scope: string;

  constructor(
    private readonly context: ExtensionContext,
    workspaceRoot: string
  ) {
    this.scope = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  }

  listNames(): string[] {
    const namesByScope = this.context.workspaceState.get<Record<string, string[]>>(
      NAMES_INDEX_KEY, {}
    );
    return [...(namesByScope[this.scope] ?? [])].sort();
  }

  has(name: string): boolean {
    return this.listNames().includes(name);
  }

  async get(name: string): Promise<string | undefined> {
    return this.context.secrets.get(this.storageKey(name));
  }

  async store(name: string, value: string): Promise<void> {
    if (!isValidHookSecretName(name)) {
      throw new Error(
        `Invalid secret name "${name}" — use letters, digits and underscores, not starting with a digit.`
      );
    }
    await this.context.secrets.store(this.storageKey(name), value);
    await this.addToIndex(name);
  }

  async delete(name: string): Promise<void> {
    await this.context.secrets.delete(this.storageKey(name));
    await this.removeFromIndex(name);
  }

  async rename(oldName: string, newName: string): Promise<void> {
    if (!isValidHookSecretName(newName)) {
      throw new Error(
        `Invalid secret name "${newName}" — use letters, digits and underscores, not starting with a digit.`
      );
    }
    if (!this.has(oldName)) {
      throw new Error(`Secret "${oldName}" does not exist.`);
    }
    if (this.has(newName)) {
      throw new Error(`Secret "${newName}" already exists.`);
    }
    const value = await this.get(oldName);
    if (value === undefined) {
      throw new Error(`Secret "${oldName}" does not exist.`);
    }
    await this.store(newName, value);
    await this.delete(oldName);
  }

  private storageKey(name: string): string {
    return `fileferry.hookSecret.${this.scope}.${name}`;
  }

  private async addToIndex(name: string): Promise<void> {
    const namesByScope = this.context.workspaceState.get<Record<string, string[]>>(
      NAMES_INDEX_KEY, {}
    );
    const names = namesByScope[this.scope] ?? [];
    if (!names.includes(name)) {
      await this.context.workspaceState.update(NAMES_INDEX_KEY, {
        ...namesByScope,
        [this.scope]: [...names, name],
      });
    }
  }

  private async removeFromIndex(name: string): Promise<void> {
    const namesByScope = this.context.workspaceState.get<Record<string, string[]>>(
      NAMES_INDEX_KEY, {}
    );
    const names = namesByScope[this.scope] ?? [];
    if (names.includes(name)) {
      await this.context.workspaceState.update(NAMES_INDEX_KEY, {
        ...namesByScope,
        [this.scope]: names.filter(existingName => existingName !== name),
      });
    }
  }
}
