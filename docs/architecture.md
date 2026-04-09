# FileFerry Architecture

This document covers the seven key design decisions that shape FileFerry's codebase.

---

## 1. Two-Tier Data Model

FileFerry separates concerns across two storage layers:

```text
SSH Credentials  (global — per VS Code install)
      │  referenced by credentialId (UUID)
      ▼
Project Config  (per workspace — .vscode/fileferry.json)
```

**SSH Credentials** (`globalStorageUri/credentials.json`) store connection details: host, port, username, auth method, and optional private key path. Secret fields (password, passphrase) are never in this file — they live in the OS keychain.

**Project Config** (`.vscode/fileferry.json`) is workspace-local. It contains:

- `defaultServerId` — UUID of the active server
- `uploadOnSave` — optional per-project toggle
- `dryRun` — optional toggle (defaults to `false`); when true, upload commands resolve paths and report the plan but skip all transfers and connections
- `fileDateGuard` — optional toggle (defaults to `true`); when false, skips the remote mtime check before upload
- `backupBeforeOverwrite` — optional toggle (defaults to `false`); when true, downloads remote files to `.vscode/fileferry-backups/` before uploading
- `backupRetentionDays` — optional number (defaults to `7`); days to keep backup folders before cleanup deletes them
- `backupMaxSizeMB` — optional number (defaults to `100`); max total backup size in MB; oldest folders are deleted until under the limit
- `historyMaxEntries` — optional number (defaults to `10000`); max entries in the upload history JSONL file; set to `0` to disable history logging
- `servers` — a map of display names to `ProjectServer` objects

Each `ProjectServer` holds its UUID (`id`), protocol (`type`), credential reference (`credentialId` + human-readable `credentialName`), `rootPath`, path `mappings`, and `excludedPaths`. It contains no secrets and is safe to commit to git.

This design means credentials are configured once and shared across all projects, while server definitions (including path mappings) are specific to each project.

**Migration from v0.4:** On activation, if a legacy `servers.json` (global) and old-format `.vscode/fileferry.json` (binding) exist, they are merged into the new project config format automatically. The old `servers.json` is left in place but no longer read.

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
    { "command": "fileferry.uploadSelected", "group": "fileferry@1" },
    { "command": "fileferry.uploadToServers", "group": "fileferry@2" }
  ]
}
```

**Argument shape**: When invoked from the SCM context menu, VSCode passes `(primaryResource: SourceControlResourceState, allSelected: SourceControlResourceState[])`. When invoked via keyboard shortcut (`Alt+U` / `Alt+Shift+U`), `allSelected` contains everything currently highlighted in the SCM panel.

**`ScmResourceResolver`** normalises both call shapes:
- If `allSelected` is non-empty, use it (multi-select case).
- Otherwise, fall back to `[primaryResource]` (single right-click case).
- Filter out resources where `resourceUri.fsPath` no longer exists on disk (deleted files).

Both `uploadSelected` and `uploadToServers` are hidden from the Command Palette (`"when": "false"`) to prevent accidental invocation outside the SCM/Explorer context.

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

All four webview panels (Deployment Settings, SSH Credentials, Project Settings, Upload History) use the same handshake pattern:

```
Webview boots → sends { command: 'ready' }
Extension responds → sends { command: 'init', ...data }
```

Using `ready`→`init` rather than injecting data into the HTML means the webview can always request a refresh, and the extension can send updated state without reconstructing the HTML.

**Message directions**:

| Direction | Panel | Commands |
| --------- | ----- | -------- |
| Webview → Extension | Deployment Settings | `ready`, `saveServer`, `deleteServer`, `setDefaultServer`, `cloneServer`, `saveMapping`, `deleteMapping`, `testConnection`, `browseDirectory`, `openCredentials` |
| Extension → Webview | Deployment Settings | `init` (`{ config, credentials }`), `configUpdated` (`{ config }`), `credentialsUpdated`, `testResult`, `validationError`, `directorySelected`, `browseDone`, `browseError` |
| Webview → Extension | SSH Credentials | `ready`, `saveCredential`, `deleteCredential`, `cloneCredential`, `testConnection`, `browsePrivateKey` |
| Extension → Webview | SSH Credentials | `init`, `credentialSaved`, `credentialDeleted`, `testResult`, `validationError`, `warning`, `privateKeySelected` |
| Webview → Extension | Project Settings | `ready`, `toggleDryRun`, `toggleUploadOnSave`, `toggleFileDateGuard`, `toggleBackupBeforeOverwrite`, `setBackupRetentionDays`, `setBackupMaxSizeMB` |
| Extension → Webview | Project Settings | `init` (`{ config }`), `configUpdated` (`{ config }`) |
| Webview → Extension | Upload History | `ready`, `filter` (`{ serverId?, result?, search? }`), `clear` |
| Extension → Webview | Upload History | `init` (`{ entries, servers }`), `filtered` (`{ entries }`), `cleared` |

**Validation flow**: All validation runs in the extension process (pure `src/utils/validation.ts` functions with no VSCode dependencies). The webview receives `{ command: 'validationError', errors: { [field]: message } }` and renders inline field errors. This keeps the webview thin and ensures validation logic is unit-testable without a webview environment.

**CSP**: All three panels use `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'` — no inline scripts, no external resources, bundled JS loaded via nonce.

---

## 6. Singleton Panel Pattern

All four webview panels (`DeploymentSettingsPanel`, `SshCredentialPanel`, `ProjectSettingsPanel`, `UploadHistoryPanel`) use a static singleton pattern:

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

**`retainContextWhenHidden: true`**: All three panels keep their JavaScript state alive when the tab is hidden. This preserves in-progress form edits when the user briefly switches tabs.

---

## 7. TransferService Abstraction

FileFerry supports multiple protocols (SFTP, FTP, FTPS) through a shared `TransferService` interface:

```typescript
interface TransferService {
  readonly connected: boolean;
  connect(server, credentials, options?): Promise<void>;
  uploadFile(localPath, remotePath): Promise<void>;
  get(remotePath): Promise<Buffer>;
  listDirectory(remotePath): Promise<Array<{ name: string; type: string }>>;
  listDirectoryDetailed(remotePath): Promise<FileEntry[]>;
  resolveRemotePath(remotePath): Promise<string>;
  statType(remotePath): Promise<'d' | '-' | null>;
  stat(remotePath): Promise<{ mtime: Date } | null>;
  deleteFile(remotePath): Promise<void>;
  deleteDirectory(remotePath): Promise<void>;
  disconnect(): Promise<void>;
}
```

**Implementations**: `SftpService` wraps `ssh2-sftp-client` for SSH-based transfers. `FtpService` wraps `basic-ftp` for plain FTP, FTPS with explicit TLS, and FTPS with implicit TLS.

**Factory**: `createTransferService(type: ServerType)` returns the correct implementation based on the server's protocol type. All consumers (upload orchestrator, backup service, file date guard, diff service, remote browser) use this factory instead of instantiating a specific service directly.

**Protocol-specific constraints**:
- FTP/FTPS only supports password authentication. The Deployment Settings webview filters the credential dropdown to password-only credentials when an FTP protocol is selected. The backend also validates this before connecting.
- Host key verification only applies to SFTP connections. FTP/FTPS connections skip the `hostVerifier` option.
- `FileEntry` is a protocol-agnostic type (`{ name, type, size, modifyTime }`) that replaces the ssh2-specific `SftpClient.FileInfo` across the codebase.
