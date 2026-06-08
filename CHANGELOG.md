# Changelog

All notable changes to FileFerry will be documented in this file.

## [0.8.11] - 2026-06-08

### Changed

- **`~/.ssh/config` resolution summary** — the summary shown on Save and Test Connection now reports only what the connection will actually use: the resolved key appears only when authentication is **Private Key** (password, SSH agent, and keyboard-interactive don't use it, so it's no longer listed). The resolved **Target** and **Key** are laid out on their own lines for readability instead of one long wrapping line.

### Docs

- README now documents `~/.ssh/config` alias support, with a screenshot of the resolution feedback.

---

## [0.8.10] - 2026-06-08

### Added

- **Use your existing `~/.ssh/config`** — SSH credentials now have a **Resolve from `~/.ssh/config`** option. Tick it and enter a `Host` alias (e.g. `prod`) instead of the host, and FileFerry reads `HostName`, `Port`, `User`, and `IdentityFile` from your SSH config at connect time (supports `*`/`?` wildcard `Host` patterns, OpenSSH first-match-wins). Config values win; anything the matching block omits falls back to what you entered, so Username and Private Key Path can be left blank when the config provides them. On **Save** and **Test Connection** a summary shows exactly what resolved — e.g. `✓ Resolved "prod" → deploy@203.0.113.10:2222` — or warns when no `~/.ssh/config` exists or no `Host` block matched, so alias mode is never silent. SFTP only; `ProxyJump`/`ProxyCommand` are not resolved yet.
- **Right-click menu on the Changed Files view** — changed files now have a context menu with **Upload** and **Compare with Remote**, matching the actions already available from the Source Control panel.

### Fixed

- **Path mappings can be entered before the first save** — the Deployment Settings **Mappings** tab was blank for a server that hadn't been saved yet, with no way to add mappings until after saving the connection. The mappings editor now renders for new servers and the mappings are saved together with the server on the first save.

---

## [0.8.9] - 2026-05-21

### Fixed

- **Changed Files view showed "No changes" when the opened folder was nested inside the git repository** — `GitService` matched a repository only when its root path exactly equalled the opened workspace folder. Opening a subfolder of a repo (e.g. `datahub/4GLOBALBOT` when `.git` lives at `datahub/`) matched nothing, so the Changed Files view and `Upload All Changed Files` reported no changes even though Source Control showed them. FileFerry now matches the repository whose root contains the workspace folder (closest one wins for nested repos) and lists only the changes inside the opened folder.

---

## [0.8.8] - 2026-05-13

### Added

- **Changed Files view** — new `FileFerry: Changed Files` tree view lists every git-changed file (working tree, index, untracked) with native VS Code file icons and SCM status decorations. Standard Shift/Ctrl multi-select works because the view is FileFerry-owned, so `Alt+U` uploads exactly the rows selected — fixing a limitation where Alt+U from the built-in Source Control panel only ever uploaded a single file regardless of selection (VS Code does not pass SCM tree selection to keybinding-invoked commands). Auto-refreshes when repositories are opened or their state changes. `Ctrl+Alt+U` (upload all changed files) also fires from this view.

### Fixed

- **Fresh uploads no longer fail with `_xstat: No such file`** — `SftpService.stat` was checking the raw SFTP_STATUS numeric code (`error.code === 2`), but `ssh2-sftp-client` actually emits `error.code === 'ENOENT'` (string). The "file doesn't exist on remote" branch in `FileDateGuard` never fired, so every first-time upload threw before the transfer started.
- **Upload errors are reported instead of swallowed** — three command handlers (`uploadSelected`, `uploadToServers`, `showRemoteDiff`) ran without an error wrapper, so SFTP failures propagated to VS Code's command runtime and vanished silently: no popup, no FileFerry output channel log. Failures now log to the output channel and surface as a notification.

### Changed

- Removed the older SCM-panel-focused `Alt+U` / `Alt+P` / `Alt+Shift+U` keybindings, which never received the SCM tree selection and therefore only ever acted on a single file. Use the new Changed Files view for keyboard multi-select; the Source Control right-click menu is unchanged.

### Docs

- README positioning updated for marketplace discovery against `vscode-sftp`.
- `docs/CONFIG.md` filled out as the `fileferry.json` schema reference.

---

## [0.8.7] - 2026-04-30

### Fixed

- **Multi-file SCM upload** — right-clicking a multi-file selection in Source Control and choosing **FileFerry: Upload** now uploads all selected files instead of just the right-clicked one. VSCode's git extension passes selections as variadic args; the previous handler only read the first two.
- **Root Path edits in Deployment Settings now apply immediately** — the Remote Files panel was caching the old SFTP session and continued listing the previous path until the window was reloaded. Saving the server now refreshes the cached path in place (no reconnect) when only `rootPath` changed; identity changes (different default server, swapped credential) drop the session so the next operation reconnects fresh.

### Changed

- **Test Connection now probes the Root Path** — after a successful credential test, FileFerry tries to list the configured Root Path and surfaces a non-blocking yellow warning if the path isn't accessible (e.g. wrong path inside a chroot). Connection success itself is reported the same as before.
- **Detect Offset banner shows the actual value** — replaces the misleading "Time offset detected" string with `Time offset: +0ms` / `Time offset: +5.2s`, and fixes a stale-state bug where the inline "Not detected" field could revert after a re-render.

---

## [0.8.6] - 2026-04-28

### Added

- **Upload All Changed Files** — new `FileFerry: Upload All Changed Files` command deploys everything git considers changed to the default server with no SCM selection required. `Ctrl+Alt+U` keybinding works from Source Control, the editor, or the Explorer. Adds a `$(cloud-upload)` button to the Source Control panel title bar. Skips directory-level git entries (typically submodules) with a warning so a stray submodule reference can't recurse into `.git` or `node_modules`. Reuses the existing confirmation, file date guard, backup, dry run, and history pipeline.
- **Upload Files from Commit** — new `FileFerry: Upload Files from Commit` command opens a multi-select picker of the last 50 commits; selecting one or more commits uploads the **current working-tree version** of every file those commits touched. Multi-commit selections union and dedupe touched paths; merge commits contribute nothing (default `git diff-tree` behavior); root commits are handled. Reuses the existing confirmation, file date guard, backup, dry run, and history pipeline. (Right-click on a commit in the Source Control Graph view is deferred — the contribution point is still behind a VS Code proposed API and cannot ship to the marketplace yet.)

---

## [0.8.5] - 2026-04-20

### Fixed

- Uploads to directories where the target file is writable but the directory itself is not (common on shared hosting) no longer fail. When creating the `.fileferry.tmp` sidecar is denied, the upload retries as a direct overwrite instead. Applies to both SFTP and FTP. Trade-off: the fallback write is non-atomic for that file.
- Long error messages in the Upload History panel are no longer cut off at 250px. Click any truncated error cell to expand it inline; click again to collapse. Previously the full text was only visible by opening the raw `.vscode/fileferry-history.jsonl` file.

---

## [0.8.3] - 2026-04-13

### Fixed

- Extension icon replaced with fully transparent background version

---

## [0.8.2] - 2026-04-13

### Fixed

- Extension icon background removed — boat renders cleanly on any VS Code theme

---

## [0.8.1] - 2026-04-13

### Fixed

- Extension icon resized from 2048x2048 to 256x256 (6 MB → 76 KB)

---

## [0.8.0] - 2026-04-13

No new features. Marketplace-ready polish release.

- Full README rewrite with feature screenshots
- Updated activity bar and extension icon
- Why FileFerry section added to README

---

## [0.7.0] - 2026-04-10

### Added

- **File and directory permissions** — set octal permissions on newly created remote files and directories. `filePermissions` and `directoryPermissions` fields in the Connection tab of Deployment Settings. SFTP uses native `chmod`; FTP sends `SITE CHMOD` (best-effort, skipped silently if unsupported)
- **Remote time offset detection** — detects clock skew between local machine and remote server by uploading a probe file to `/tmp/.fileferry-time-probe` and measuring the timestamp difference. Offset stored per-server and automatically applied by File Date Guard to prevent false "remote is newer" warnings. Auto-runs during Test Connection; "Detect Offset" button available for manual re-detection. UI shows the formatted offset (e.g. `+2.5s`)
- **Dry run mode** — preview what would be uploaded without connecting or transferring any files. `DryRunReporter` writes a structured plan to the Output channel. Status bar shows `$(eye) server — DRY RUN` when active. Toggle via Project Settings panel, status bar menu, or `fileferry.json`
- **Upload history panel** — persistent JSONL-based log of every upload (manual, multi-server, upload-on-save). `UploadHistoryPanel` webview shows a searchable, filterable table with server and result filters, a file search field, and a clear button. Configurable retention via `historyMaxEntries` (default 10,000; set to 0 to disable). Accessible from Command Palette, status bar menu, and post-upload notification

---

## [0.6.0] - 2026-04-08

### Added

- **FTP / FTPS support** — deploy over plain FTP, FTPS with explicit TLS, or FTPS with implicit TLS. Protocol-agnostic `TransferService` interface lets all existing features (upload, browse, compare, backup, file date guard) work identically across SFTP and FTP
- **Protocol selection in Deployment Settings** — new dropdown with four options: SFTP, FTP, FTPS (Explicit TLS), FTPS (Implicit TLS). Credential dropdown filters to password-only credentials when an FTP protocol is selected
- **Atomic FTP upload** — FTP uploads use temp file + rename, matching the existing SFTP atomic upload behavior
- **Symlink support in Remote File Browser** — symlinked directories are now expandable in the Remote File Browser and directory picker. `stat()` follows symlink targets so they behave like real directories. Circular and broken symlinks fall back to file treatment gracefully

---

## [0.5.0] - 2026-04-07

### Added

- **Project-scoped server definitions** — server configs moved from global `servers.json` into per-project `.vscode/fileferry.json`. Two-tier model: credentials (global, keychain) → project config (per-workspace). Auto-migration from v0.4 format on activation
- **Project settings UI** — dedicated webview for project-level toggles (upload on save, file date guard, backup before overwrite). Separate from the server-scoped Deployment Settings panel
- **Multi-server simultaneous push** — new "Upload to Servers" command (`Alt+Shift+U`) with multi-select QuickPick. Per-server path resolution, FileDateGuard, and credentials. Parallel uploads via Promise.all with shared cancellation token
- **Backup before overwrite** — downloads remote files to `.vscode/fileferry-backups/<timestamp>-<server>/` before uploading. Configurable retention days and max size via Project Settings. Cleanup runs automatically at the start of each upload
- **Progress stage notifications** — deploy notification now shows live stages: "Checking remote files...", "Backing up remote files...", "Uploading..." instead of appearing only after pre-upload checks complete
- **Explorer keybindings** — `Alt+U`, `Alt+P`, and `Alt+Shift+U` now work when the Explorer panel has focus (previously only worked in SCM panel and editor)

---

## [0.4.0] - 2026-04-06

### Added

- **Upload on save** — auto-deploy when a file is saved. Toggle per-project via status bar menu or `fileferry.json`. Respects `.gitignore` via `git check-ignore`. Status bar icon switches between `$(cloud-upload)` (ON) and `$(server)` (OFF), flashes on upload
- **Folder upload** — right-click a folder in Explorer to upload all files within it recursively. Existing auto-mkdir creates remote directories on the fly
- **Ignore patterns** — gitignore-style glob exclusions in `fileferry.json`. `matchBase` enabled so bare patterns like `*.log` match at any depth. Dotfiles matched by default. "Upload Anyway" prompt when exclusions block a manual upload
- **Atomic upload** — uploads write to a `.fileferry.tmp` temp file first, then rename to the final path using POSIX rename (atomic overwrite). Falls back to standard rename for servers without the OpenSSH extension. Orphaned temp files cleaned up on failure
- **File date guard** — warns before overwriting a remote file that has a newer timestamp than the local file. Runs before both manual uploads and upload-on-save. Always on (config toggle planned for v0.5)
- **Cancel all transfers** — cancel button in the progress notification stops all in-flight uploads. Completed files are kept, remaining files reported as cancelled
- **Editor keybindings** — `Alt+U` (upload) and `Alt+P` (compare with remote) now work from the editor when no SCM selection is active, using the active editor's file

---

## [0.3.0] - 2026-04-05

### Added

- **Modern OpenSSH algorithm support** — explicit default algorithms (rsa-sha2-256, rsa-sha2-512, curve25519-sha256, etc.) ensure compatibility with OpenSSH 8.8+ servers. Per-server algorithm override available via `ServerConfig.algorithms`
- **PEM key support** — `.pem` private key files (common for AWS EC2) work out of the box. Clear error messages when a key file is missing or unparseable ("Supported formats: OpenSSH, PEM, PPK")
- **SSH agent enhancement** — automatic socket discovery: checks `SSH_AUTH_SOCK`, then 1Password agent (`~/.1password/agent.sock`), then Pageant on Windows. Optional custom socket path per credential
- **Host key verification** — first-connection trust prompt with SHA-256 fingerprint, critical warning when a server's host key changes (MITM protection). Trusted keys stored in `known_hosts.json` in global storage
- **Keyboard-interactive auth (2FA)** — new authentication method for servers requiring challenge-response / two-factor authentication. VS Code input prompts shown for each server challenge
- **Browse button for private key path** — file picker dialog in the SSH Credentials form instead of typing the full path manually
- **Clone credential** — duplicate an existing SSH credential from the credentials list (hover to reveal clone button). Copies all fields including secrets from the OS keychain

---

## [0.2.1] - 2026-04-04

### Added

- **Download to Workspace** — right-click a remote file → "Download to Workspace". Resolves the local path using reverse path mapping and writes to the workspace. Prompts for a save location if no mapping matches
- **Compare with Local** — right-click a remote file → "Compare with Local". Downloads the remote version to a temp file and opens VS Code's diff editor with remote on the left, local on the right
- **Delete from Server** — right-click a remote file or folder → "Delete from Server". Mandatory confirmation dialog; directories are deleted recursively
- **Copy Remote Path** — right-click any item in the Remote Files panel → "Copy Remote Path". Writes the full remote path to clipboard
- **Current path indicator** — the Remote Files view header now shows the current browsing path (e.g. `Remote Files /var/www/html`)
- **Reconnect from error state** — clicking "Connection failed" or "Permission denied" in the Remote Files panel now triggers a reconnect attempt. "No server configured" opens Deployment Settings
- **Context menus** — Remote Files panel items have grouped right-click menus: transfer actions (Download, Compare), utility actions (Copy Path, Refresh), and destructive actions (Delete)

### Fixed

- **Keybinding fallback** — `Alt+U` (upload) and `Alt+P` (compare) now fall back to the active editor when triggered via keybinding instead of showing "no files selected"

---

## [0.2.0] - 2026-04-03

### Added

- **Remote File Browser** — dedicated sidebar panel in the activity bar to browse the remote server's filesystem. Expand directories lazily, click any file to download and view it in the editor. File type icons provided by your active VS Code icon theme. Persistent SFTP connection with 5-minute idle timeout and automatic reconnection
- **Servers panel** — sidebar panel showing all configured servers with visual active/inactive state (filled/outline circle). Click a server to set it as the project default. Right-click for Edit and Test Connection. Refresh button and settings shortcut in the toolbar
- **Welcome views** — onboarding guidance shown when no servers are configured. "Add Server" and "Add SSH Credential" buttons appear in the empty Servers and Remote Files panels
- **Go to Remote Path** command — navigate the Remote File Browser to any remote directory by typing a path
- **Disconnect Remote Browser** command — manually close the remote SFTP connection
- **Theme-aware file icons** — remote files show the same icons as local files (based on file extension and your installed icon theme)
- **Root path override support in browser** — Remote File Browser respects per-project `rootPathOverride` from `fileferry.json`

---

## [0.1.0] - 2026-03-30

### Added

- **Native SCM panel integration** — right-click any changed file in Source Control and choose `FileFerry: Upload` or `FileFerry: Compare with Remote`
- **Explorer panel integration** — Upload and Compare with Remote also available by right-clicking files in the Explorer file tree
- **Multi-select upload** — select multiple files in Source Control, press `Alt+U` to upload them all at once
- **SFTP upload** — upload files to remote servers over SSH using password, private key, or SSH agent authentication
- **Compare with Remote** (`Alt+P`) — opens VSCode's built-in diff editor showing your local file alongside the version currently on the server
- **Delete deployment** — git-deleted files can be deployed to remove them from the server; confirmation is always shown for destructive operations
- **Settings UI** — manage servers and path mappings through a form (`FileFerry: Deployment Settings`)
- **SSH Credentials Manager** — add SSH credentials once (`FileFerry: Manage SSH Credentials`), reuse across projects
- **OS keychain storage** — passwords and passphrases stored in macOS Keychain / Windows Credential Manager / Linux libsecret. Never written to disk
- **Multiple servers** — configure production, staging, and dev servers; switch with `FileFerry: Switch Server` or click the status bar
- **Clone server** — duplicate an existing server config as a starting point for a new one
- **Root Path Override** — override a server's root path for a specific project without changing the shared server definition
- **Remote directory browser** — browse the server's filesystem interactively when setting the root path in Deployment Settings
- **Path mappings** — map workspace subfolders to different remote paths per server; empty mapping array falls back to mapping everything directly to the server root
- **Excluded paths** — glob patterns to skip files that should never be deployed
- **Test Connection** — verify SSH credentials before your first deploy, from both the Deployment Settings and Credentials panels; uses stored keychain secret when password field is left blank
- **Status bar indicator** — shows the active server name for the current workspace
- **Upload confirmation** — summarises files before every deploy; "don't ask again" option per server for upload-only deploys; always shown when deletions are included
- **Save feedback** — success notifications shown after saving SSH credentials, server configuration, and path mappings
- **Automatic remote directory creation** — missing intermediate directories are created on the remote before upload
- **Private key permission check** — warns when a key file has loose permissions (`644` instead of `600`)
- **Project binding** — per-project server selection and path mappings stored in `.vscode/fileferry.json` (no secrets, safe to commit)
- **Output channel** — all errors and activity logged to the FileFerry output channel
- **JSON schema validation** — `.vscode/fileferry.json` is validated against a bundled schema for autocomplete and inline error checking
