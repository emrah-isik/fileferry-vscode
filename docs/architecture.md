# FileFerry Architecture

This document covers the six key design decisions that shape FileFerry's codebase.

---

## 1. Three-Tier Data Model

FileFerry separates concerns across three distinct storage layers:

```
SSH Credentials  (global — per VS Code install)
      │  referenced by credentialId
      ▼
Deployment Servers  (global — per VS Code install)
      │  referenced by serverId
      ▼
Project Binding  (per workspace — .vscode/fileferry.json)
```

**SSH Credentials** (`globalStorageUri/credentials.json`) store connection details: host, port, username, auth method, and optional private key path. Secret fields (password, passphrase) are never in this file — they live in the OS keychain.

**Deployment Servers** (`globalStorageUri/servers.json`) store a display name, protocol, a reference to a credential by ID, and a root path on the remote server. A server has no path mapping knowledge — that belongs to the binding.

**Project Binding** (`.vscode/fileferry.json`) is workspace-local. It records the `defaultServerId` and a per-server map of local→remote path mappings and exclusion patterns. It contains no secrets and is safe to commit to git.

This design means credentials and servers are configured once and shared across all projects, while path mappings are specific to each project and kept alongside the code.

---

## 2. Secret Storage Strategy

Passwords and passphrases never touch the filesystem.

- **Storage**: VSCode's `SecretStorage` API (`context.secrets`) maps credential IDs to JSON blobs `{ password?, passphrase? }`. SecretStorage is backed by the OS native keychain (macOS Keychain, Windows Credential Manager, Linux libsecret).
- **Webview isolation**: `CredentialManager.getAll()` returns credentials without secret fields. The `init` message sent to webviews on load never contains passwords.
- **Transient secrets**: The SSH Credentials form sends passwords to the extension only on explicit Save or Test Connection actions, and only in those message payloads. They are never re-displayed after save.
- **Blank = keep existing**: Saving a credential with an empty password/passphrase string passes `undefined` to `CredentialManager.save()`, which skips the keychain write — leaving the previously stored secret intact.
- **Agent auth**: When `authMethod` is `agent`, no secrets are stored or requested at all. The SSH agent socket handles authentication.
- **Keyboard-interactive auth**: When `authMethod` is `keyboard-interactive`, no secrets are stored. The server sends challenges at connection time and the user responds via VS Code input prompts.
- **Host key verification**: Trusted host keys are stored in `globalStorageUri/known_hosts.json` as `{ "[host]:port": { type, key, addedAt } }`. On first connection, the user is prompted to trust the key. If a key changes, a critical warning is shown. The `HostKeyManager` class handles storage; `hostKeyPrompt` handles the VS Code modal UI.

---

## 3. SCM Integration

FileFerry hooks into VSCode's native Source Control panel rather than building its own file tree.

**Command registration** (`package.json`):
```json
"menus": {
  "scm/resourceState/context": [
    { "command": "fileferry.uploadSelected", "group": "fileferry@1" }
  ]
}
```

**Argument shape**: When invoked from the SCM context menu, VSCode passes `(primaryResource: SourceControlResourceState, allSelected: SourceControlResourceState[])`. When invoked via keyboard shortcut (`Alt+U`), `allSelected` contains everything currently highlighted in the SCM panel.

**`ScmResourceResolver`** normalises both call shapes:
- If `allSelected` is non-empty, use it (multi-select case).
- Otherwise, fall back to `[primaryResource]` (single right-click case).
- Filter out resources where `resourceUri.fsPath` no longer exists on disk (deleted files).

The `uploadSelected` command is hidden from the Command Palette (`"when": "false"`) to prevent accidental invocation outside the SCM context.

---

## 4. Path Resolution

`PathResolver.resolve()` maps a local absolute path to a remote absolute path using the server's root path and the active server binding's path mappings.

**Algorithm**:
1. Convert the local absolute path to a workspace-relative path.
2. Check exclusion patterns using `minimatch`. If any pattern matches, throw `ExcludedPathError`.
3. Find the mapping with the longest `localPath` prefix that matches the relative path. More-specific mappings win over catch-all `/` mappings.
4. Combine: `server.rootPath` + `mapping.remotePath` + path suffix after the mapping prefix.

**Example**:
```
rootPath: /var/www
mappings: [{ localPath: '/', remotePath: '/html' },
           { localPath: '/public', remotePath: '/public_html' }]

local: /workspace/public/index.php
  → workspace-relative: /public/index.php
  → best match: /public (longer than /)
  → remote: /var/www/public_html/index.php
```

If no mapping matches and there is no `/` catch-all, a `NoMappingError` is thrown and the file is skipped with a warning.

---

## 5. Webview Message Protocol

Both webview panels (Deployment Settings, SSH Credentials) use the same handshake pattern:

```
Webview boots → sends { command: 'ready' }
Extension responds → sends { command: 'init', ...data }
```

Using `ready`→`init` rather than injecting data into the HTML means the webview can always request a refresh, and the extension can send updated state without reconstructing the HTML.

**Message directions**:

| Direction | Commands |
|-----------|----------|
| Webview → Extension | `ready`, `saveServer`, `deleteServer`, `setDefaultServer`, `cloneServer`, `saveMapping`, `deleteMapping`, `testConnection`, `openCredentials`, `saveCredential`, `deleteCredential`, `cloneCredential`, `browsePrivateKey` |
| Extension → Webview | `init`, `serverSaved`, `serverDeleted`, `bindingUpdated`, `mappingSaved`, `credentialSaved`, `credentialDeleted`, `testResult`, `validationError`, `warning`, `privateKeySelected` |

**Validation flow**: All validation runs in the extension process (pure `src/utils/validation.ts` functions with no VSCode dependencies). The webview receives `{ command: 'validationError', errors: { [field]: message } }` and renders inline field errors. This keeps the webview thin and ensures validation logic is unit-testable without a webview environment.

**CSP**: Both panels use `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'` — no inline scripts, no external resources, bundled JS loaded via nonce.

---

## 6. Singleton Panel Pattern

Both webview panels (`DeploymentSettingsPanel`, `SshCredentialPanel`) use a static singleton pattern:

```typescript
class DeploymentSettingsPanel {
  private static currentPanel: DeploymentSettingsPanel | undefined;

  static createOrShow(context, deps): void {
    if (DeploymentSettingsPanel.currentPanel) {
      DeploymentSettingsPanel.currentPanel.panel.reveal(column);
      return;
    }
    // create new panel...
    DeploymentSettingsPanel.currentPanel = new DeploymentSettingsPanel(...);
  }

  dispose(): void {
    DeploymentSettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    // clean up disposables...
  }
}
```

**Why**: VSCode allows multiple webview panels of the same type to exist simultaneously, which would result in duplicate settings tabs. The singleton ensures there is at most one instance of each panel open at any time.

**Cross-panel navigation**: The "Manage Credentials" button in Deployment Settings sends `{ command: 'openCredentials' }` to the extension, which calls `vscode.commands.executeCommand('fileferry.openCredentials')`. This keeps the two panels decoupled — neither panel holds a reference to the other.

**`retainContextWhenHidden: true`**: Both panels keep their JavaScript state alive when the tab is hidden. This preserves in-progress form edits when the user briefly switches tabs.
