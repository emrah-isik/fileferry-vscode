# FileFerry Architecture

This document covers the nine key design decisions that shape FileFerry's codebase.

---

## 1. Two-Tier Data Model

FileFerry separates concerns across two storage layers:

```text
SSH Credentials  (global — per VS Code install)
      │  referenced by credentialId (UUID)
      ▼
Project Config  (per workspace — .vscode/fileferry.json)
```

**SSH Credentials** (`globalStorageUri/credentials.json`) store connection details: host, port, username, auth method, optional private key path or agent socket path, and an optional ordered `jumpHosts` list of other credential ids (first hop → last hop before the target; flat — validation rejects nesting from both sides, self-reference, and dangling ids). Secret fields (password, passphrase) are never in this file — they live in the OS keychain.

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
- **Keyboard-interactive auth**: When `authMethod` is `keyboard-interactive`, no secrets are stored. Challenges are not tied to that method, though: since 18a-1a every interactive SSH connect sets `tryKeyboard`, so a server whose `AuthenticationMethods` adds `keyboard-interactive` after a key or password step gets its challenges answered through the same VS Code input prompts (see *SSH connect providers* in §7). For password credentials, one `/password/i` challenge is answered from the keychain before the user is asked.
- **Host key verification**: Trusted host keys are stored in `globalStorageUri/known_hosts.json` as `{ "[host]:port": { type, key, addedAt } }` — `key` is the base64 host-key blob ssh2 hands to `hostVerifier`, `type` is `ssh2.utils.parseKey(key).type` (`ssh-unknown` when unparseable, and on every entry written before 0.14.1). **Matching is on `key` alone; `type` is informational.** On first connection the user is prompted to trust the key; if a key changes, a critical warning is shown. `HostKeyManager` handles storage (writes are serialised through an in-process promise chain); `hostKeyPrompt` handles the VS Code modal UI; `VscodeHostKeyProvider` (`src/ssh/vscodeConnectProviders.ts`) ties them together and is applied to **every** SSH connect through the provider registry (§7) — not only the Remote Files panel, as in 0.14.1. Prompting is reserved for interactive connects; a background connect (`interactive: false`, §7) uses the provider's store-only `checkStored` and fails closed instead of prompting. **The `hostVerifier` passed to ssh2 must be the callback form** `(key, verify) => void` — ssh2 (`lib/client.js`) treats any non-`undefined` return value, a Promise included, as the verdict, so an `async` verifier auto-accepts before the prompt resolves (the 0.14.1 fix); `TransferService.connect`'s option type admits only that shape. Errors during the check fail closed (`verify(false)`).

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

```text
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

```text
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
| Extension → Webview | SSH Credentials | `init` (optionally `{ selectedId }` to preselect — Deployment Settings' Manage… link passes the server's current credential), `selectCredential` (switches selection when the panel is already open), `credentialSaved`, `credentialDeleted`, `testResult` (a jump-host failure additionally carries `{ hopIndex, hopHost }` so the webview can name the failing hop — 18a-2b), `validationError`, `warning`, `privateKeySelected` |
| Webview → Extension | Project Settings | `ready`, `toggleDryRun`, `toggleUploadOnSave`, `toggleFileDateGuard`, `toggleBackupBeforeOverwrite`, `setBackupRetentionDays`, `setBackupMaxSizeMB` |
| Extension → Webview | Project Settings | `init` (`{ config }`), `configUpdated` (`{ config }`) |
| Webview → Extension | Upload History | `ready`, `filter` (`{ serverId?, result?, search? }`), `clear` |
| Extension → Webview | Upload History | `init` (`{ entries, servers }`), `filtered` (`{ entries }`), `cleared` |

**Validation flow**: All validation runs in the extension process (pure `src/utils/validation.ts` functions with no VSCode dependencies). The webview receives `{ command: 'validationError', errors: { [field]: message } }` and renders inline field errors. This keeps the webview thin and ensures validation logic is unit-testable without a webview environment.

**CSP**: All four panels use `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'` — no inline scripts, no external resources, bundled JS loaded via nonce.

The Deployment Settings panel additionally carries the hook-secrets messages (`storeSecret`, `deleteSecret`, `renameSecret` → `secretsUpdated`/`secretError`): secret *names* flow to the webview for the missing-secret indicators, secret *values* only ever flow inward on an explicit store.

The SSH Credentials panel's jump-host picker (18a-2b) needs no messages of its own: `init` already carries every credential's `jumpHosts`, the webview keeps the picker edits as a per-selection draft (mirroring `validateSshCredential`'s chain rules for eligibility), and the draft rides out in the ordinary `saveCredential`/`testConnection` payloads. Ids are stored, names are display-only.

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

**`retainContextWhenHidden: true`**: All four panels keep their JavaScript state alive when the tab is hidden. This preserves in-progress form edits when the user briefly switches tabs.

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
  mkdir(remotePath, recursive?): Promise<void>;
  exists(remotePath): Promise<boolean>;
  deleteFile(remotePath): Promise<void>;
  deleteDirectory(remotePath): Promise<void>;
  rename(oldPath, newPath): Promise<void>;
  chmod(remotePath, mode): Promise<void>;
  disconnect(): Promise<void>;
}
```

**Implementations**: `SftpService` wraps `ssh2-sftp-client` for SSH-based transfers. `FtpService` wraps `basic-ftp` for plain FTP, FTPS with explicit TLS, and FTPS with implicit TLS.

**Factory**: `createTransferService(type: ServerType)` returns the correct implementation based on the server's protocol type. All consumers (upload orchestrator, backup service, file date guard, diff service, remote browser) use this factory instead of instantiating a specific service directly.

**Remote command execution is deliberately NOT on the interface.** Only SSH transports can exec, so `RemoteCommandRunner` (`execCommand`) is a separate capability implemented by `SftpService` alone; callers narrow with the `canExec()` type predicate; the ssh2 `Client` it execs on comes from `getRawClient()` (`src/ssh/rawClient.ts`), the single typed accessor for ssh2-sftp-client's unpublished `.client`. `execCommand` returns stdout, stderr, and the raw exit code without judging success — hook failure is decided on **exit code only**, never on stderr (servers print MOTD/banners to stderr on success). Deploy hooks (feature 27) are its only consumer today (the v0.15 SSH terminal will be the second).

**Protocol-specific constraints**:

- FTP/FTPS only supports password authentication, and cannot use jump-host chains (they are SSH tunnels). The Deployment Settings webview filters the credential dropdown to password-only, chain-free credentials when an FTP protocol is selected; `validateProjectServer` rejects the combination at save time, `handleTestConnection` pre-checks it before dialing, and `FtpService.connect` — the last line of defence against a hand-edited config — warns through the registry's `warn` sink and connects directly rather than silently ignoring the chain (Q9/M7).
- Host key verification applies to every SFTP connection: `SftpService.connect()` takes the `HostKeyProvider` from the registry below unless the caller passes an explicit `hostVerifier`. FTP/FTPS have no SSH host key and pass nothing.
- `FileEntry` is a protocol-agnostic type (`{ name, type, size, modifyTime, mode? }`) that replaces the ssh2-specific `SftpClient.FileInfo` across the codebase. `mode` is the listing-derived octal permission string (`"644"`) — always present on SFTP, only for unix-style listings on FTP; consumers must not assume it.
- FTP `mkdir` is basic-ftp's `ensureDir`: it always creates missing parents *and* changes the client's working directory — acceptable only because every FileFerry remote path is absolute and callers pre-check collisions with `exists()`.
- Honest failures: `FtpService.chmod` propagates `SITE CHMOD` rejections (the deploy path best-efforts at its own call site), and an **empty** FTP listing is verified with a `cd` probe — some servers report permission-denied directories as empty, which would otherwise let a recursive copy silently skip a subtree.

**SSH connect providers** (`src/ssh/connectProviders.ts`, vscode-free; implementations in `src/ssh/vscodeConnectProviders.ts`, registered once from `extension.ts`):

- `connectProviderRegistry` is set once at activation with a `KeyboardInteractiveProvider` (`prompt(request, context) → string[] | null`, `null` = cancelled), a `HostKeyProvider` (`verify(target, key, context, verdict): void` — **callback form only**, the same ssh2 contract as `hostVerifier`; an `async` implementation would auto-accept), and a `log` sink. `SftpService.connect()` uses them for every connect whose `options` carry no explicit `hostVerifier` / `keyboardInteractive` (explicit wins), so no call site wires prompt UI. `sftpService.ts` still imports no `vscode`.
- Whether a connect may raise UI is the caller's call: `connect(server, credentials, { interactive })` (default `true`; on the `TransferService` interface, threaded through `FileDateGuard.check`/`partitionByNewerLocal`, `BackupService.backup`, `UploadOrchestratorV2.upload`, and `RemoteBrowserConnection.ensureConnected`). **Interactive** (a provider must also be present for prompts to exist): `tryKeyboard: true` for *every* auth method (ssh2 never attempts keyboard-interactive otherwise, so a `publickey,keyboard-interactive` server could not authenticate) and `readyTimeout: 0` — ssh2's timer spans the whole auth phase and would kill a TOFU modal or an OTP typed from a phone. Instead a `PrePromptTimer` (20 s) guards only the stretch before the first prompt opens (`context.promptOpened()` cancels it); the connect is raced against it and against a cancelled prompt, and the client is ended on either.
- **`interactive: false` never prompts but still verifies** (18a-1b): the host key goes through the provider's `checkStored(target, key)` — a store-only lookup that never writes — and an `unknown`/`changed` verdict fails the connect closed with `HostNotTrustedError` (`src/ssh/connectErrors.ts`, vscode-free); a keyboard-interactive credential fails before dialing with `VerificationRequiredError`; `tryKeyboard: false`, ssh2's default `readyTimeout`, no timer, and the explicit `hostVerifier`/`keyboardInteractive` options are ignored too. Both errors extend `InteractionRequiredError`, which the background callers recognise: upload-on-save and the watcher (both of upload-on-save's connections), `files.autoSave`-driven remote-edit saves, and the Remote Files tree's no-gesture root render — the first three surface the shared non-modal warning (`src/ui/verificationRequiredWarning.ts`, with a *Test Connection* button), the tree shows a *Host not verified — click to connect* placeholder row whose click goes through `resume()` and is therefore an interactive render. Connects with no providers registered (unit tests) also keep ssh2's defaults and `tryKeyboard: false`.
- `createKeyboardInteractiveListener` builds the per-session `keyboard-interactive` listener. ssh2 emits one event per `USERAUTH_INFO_REQUEST`, so a PAM stack yields several *rounds*; the listener counts them and **coalesces per `(user@host:port, round, prompt texts)`** through the registry's `KeyboardInteractiveCoordinator`: concurrent connects hitting the same round of the same challenge await the one open prompt; a round-2 prompt never receives a round-1 answer. A cancelled shared prompt aborts every waiter. When the server repeats an identical prompt after a *replayed* answer (TOTP servers reject reuse) the session is re-prompted once, directly; a third identical prompt is answered empty so ssh2 fails the auth cleanly. Password credentials answer one `/password/i` challenge from the keychain first. ssh2's default auth handler offers keyboard-interactive exactly **once** per connection, so a rejected silent keychain answer would otherwise consume the only attempt before the user sees anything ("All configured authentication methods failed"); `connect()` therefore reconnects once with the auto-answer disabled when an auth failure follows a keychain answer that never showed a prompt — at most one retry, never after the user actually typed. The retry offers **keyboard-interactive only** (no password auth): the password is known-rejected, and stock Ubuntu sshd (`UsePAM`) kills the connection after a successful keyboard-interactive auth that follows a failed password auth on the same connection (reproduced with the OpenSSH CLI itself).
- Route/prompt lines go to the plain `FileFerry` output channel with an `[ssh]` prefix. That channel is **not** secret-masked, so the log receives target, round and outcome only — never an answer or password.

**Jump-host chains** (`src/ssh/chainConnect.ts` + `src/ssh/JumpHostPool.ts`, both vscode-free — 18a-2a):

- When the resolved credential has `jumpHosts`, `SftpService.connect()` calls `chainConnect([hop…, target])`: every hop is leased from the pool, each hop *N*+1 dials over a fresh `forwardOut('127.0.0.1', 0, next.host, next.port)` from hop *N*, and the last hop's forward to the target becomes the `sock` that `ssh2-sftp-client.connect()` passes to ssh2 untouched (verified pass-through — no raw-client fallback). Hop clients are raw `ssh2.Client`s owned by the chain layer; each dial registers its own keyboard-interactive listener and host verifier honouring the same `interactive` flag as the target connect (interactive: provider `verify` + the pre-prompt timer; background: store-only `checkStored`, failing closed with `HostNotTrustedError`, and a keyboard-interactive hop fails before dialing with `VerificationRequiredError`). The keychain-retry constraint applies per hop too: after a rejected silent keychain answer the re-dial drops the known-rejected password and asks the user.
- Failures wrap in `HopConnectError { hopIndex, hopHost, cause }` (a refused forward to the target is attributed to the last hop — that is where `AllowTcpForwarding`/`PermitOpen` live); `SftpService` re-throws an `InteractionRequiredError` cause directly so the 18a-1b background fail-fast handling works through chains. The route is logged once per connect (`[ssh] route: local → …`), never with secrets.
- **`JumpHostPool`** shares live *hop* connections only (target sessions are never pooled): ref-counted leases keyed by canonical `user@hostname:port` after resolution (hostname lowercased; two credentials resolving to the same key share the first-connected client, logged). Concurrent acquires share one in-flight dial — a cancelled prompt rejects every waiter, an auth failure gives each waiter one retry of its own. Pooled hops set `keepaliveInterval: 15000` / `keepaliveCountMax: 3`; an unexpected close/error evicts the connection and fires `onDidEvict(key)`; a failed `forwardOut` evicts and reconnects **once** (which may legitimately re-prompt the bastion's MFA — logged `re-authenticating to <hop>`) before retrying the forward. The singleton lives in `extension.ts` and reaches the connect path through the registry's `jumpHosts` entry (pool + hop-credential resolver — `CredentialManager.getWithSecret` needs the VS Code context, `chainConnect` must not).
- **Connection lifetime**: deploy sessions stay per-operation (connect, transfer, disconnect) and the Remote Files panel keeps its 5-minute idle session — but the *hops under them* outlive them: the last release starts a 5-minute idle timer, so a bastion password/OTP is asked once per idle window rather than once per session. `drain()` — wired to `FileFerry: Disconnect Remote Browser` via `src/commands/disconnectRemoteBrowser.ts` (18a-2b, no separate command) — closes idle hops immediately and marks held hops close-on-last-release — it never cuts a hop under a live session.
- **Credential changes propagate** (18a-2b, H3): `CredentialManager` fires `onDidChange({ id, kind: 'save' | 'delete' })` after every write — the single source of change events, so programmatic saves (the future importer) behave like panel edits. Subscribers, wired in `extension.ts`: the pool's `evictBySourceId(id)` closes hops dialed with the changed credential (this one **does** fire `onDidEvict`, unlike drain/idle closes — live holders' tunnels just died); `RemoteBrowserConnection` drops a session whose own credential changed and aborts an in-flight connect using it; and the extension-level `credentialsChangedEmitter` (now a thin void adapter over the manager event — `SshCredentialPanel` no longer reports changes itself) refreshes the Servers view and Deployment Settings.
- **`onDidEvict` consumers** (Q34): `RemoteBrowserConnection` records its session's hop pool keys at connect; on a matching eviction it fires `onDidLoseRoute`, and `RemoteBrowserProvider` drops the panel to its existing Disconnected/click-to-reconnect state. Short-lived sessions just fail with `HopConnectError`; the terminal consumer arrives with feature 20.
- **Cancellable connects** (18a-2b §I wedge fix): `connect()` accepts `options.signal` (an `AbortSignal`); aborting rejects the connect with `ConnectionCancelledError`, ends the client, releases chain leases, and — via `PromptContext.signal` → the keyboard-interactive provider → a `CancellationToken` on the input box — dismisses an open prompt (`ignoreFocusOut` would otherwise keep it alive). `chainConnect` races every acquire/forward against the signal and releases a lease that settles after the race. `RemoteBrowserConnection` uses this to guard its single shared connection: overlapping `ensureConnected` calls join one in-flight connect, and a default-server change, credential change, suspend, or disconnect aborts it — previously a connect parked on an open MFA prompt (chain phase, `connected` still false) survived the switch and wedged every later panel render until Reload Window.
- Accepted quirk (R8-14): hops are verified by `host:port` as typed, so two *different* private hosts that share an IP behind different bastions collide in the trust store exactly as they would in OpenSSH's `known_hosts` — the second one triggers the changed-key warning.

---

## 8. Deploy Hooks and Secret Resolution

Per-server `preDeploy`/`postDeploy` hooks live in the committed `fileferry.json`. Local hooks run via `spawn(cmd, { shell: vscode.env.shell || true })` at the workspace root; remote hooks run over the deploy's own SSH connection (see `RemoteCommandRunner` above). They are wired into `UploadOrchestratorV2` behind a `runHooks` flag so that only **deliberate** deploys fire them — upload-on-save, the watcher, and every Remote Files panel operation never do. Order: local pre → connect → remote pre → transfer → post; a failed pre-hook aborts before any transfer.

**Secrets** (`${secret:NAME}`): `HookSecretManager` stores values in `context.secrets`, keyed per project by a hash of the workspace root; the committed config only ever holds the reference by name. Resolution happens at the last moment before a hook runs (`hookSecretResolution`): local hooks get the value injected as an environment variable (the token is rewritten to the shell's own `$NAME` syntax, so the value never enters the command string); remote hooks inline it at exec time. A pre-flight check aborts the whole deploy before any transfer when a hook that would run references a missing secret. `SecretMaskingOutputChannel` masks resolved values as `••••` in all output.

---

## 9. The Remote Files Panel Write Layer

The panel graduated from a browser to a file manager (features 32–33). Its design pivots:

- **`RemoteBrowserConnection`** owns one lazily-connected `TransferService` for the panel: `ensureConnected()` before every operation, a 5-minute idle timeout after each, reconnect keyed to server *identity* (a default-server or credential change drops the session; a `rootPath` edit doesn't). Panel writes go through its thin passthroughs (`uploadFile`, `createDirectory`, `rename`, `chmod`, `statRemoteType`, deletes) — never through `UploadOrchestratorV2`, which is exactly why panel operations can never fire deploy hooks.
- **Edit sessions**: opening a remote file downloads it to a temp path and registers a `RemoteEditSessionRegistry` entry (server identity, remote path, baseline mtime + sha256). `RemoteEditSaveListener` uploads on save, using raw mtime *inequality* plus a sha256 comparison to separate *changed* (conflict modal) from merely *touched* (silent upload), and re-baselines after every successful upload. Renames and moves call `rewriteRemotePath(serverId, oldPath, newPath)` — exact match for files, prefix match for folders — so open sessions follow the file instead of recreating it under the old name.
- **Two remote walkers with opposite error contracts** — deliberately: `SyncTreeWalker.walkRemoteTree` swallows listing errors into an empty subtree (correct for sync: "remote root not created yet" means everything uploads), while `StrictRemoteTreeWalker.walkRemoteTreeStrict` **throws** on any listing error and also emits directories (empty ones must be recreated). Folder duplication uses the strict walker: a blind spot aborts before a single write rather than producing a partial copy that reports success.
- **History triggers**: `UploadHistoryEntry.trigger` is a closed union (`manual | multi-server | save | watch | sync | remote-edit | remote-create | remote-duplicate | remote-upload`). Panel operations that move bytes log with their own trigger; rename/move/chmod/delete log nothing, keeping the `action` union (`upload | delete`) untouched.
- **Remote-window pickers**: in remote windows (`vscode.env.remoteName` set) the native file dialog degrades to VS Code's simple dialog, which can't confirm a folder from its list and ignores multi-select. `pickLocalDirectory` (navigation QuickPick with an explicit confirm row) and `pickLocalFiles` (two-step: folder, then a `canPickMany` checkbox list) replace it there; desktop windows keep native dialogs. `pickRemoteDirectory` is the same navigation pattern over the panel's own connection, used by Move.
