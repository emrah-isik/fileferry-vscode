# Changelog

All notable changes to FileFerry will be documented in this file.

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
- **PhpStorm-style Settings UI** — manage servers and path mappings through a form (`FileFerry: Deployment Settings`)
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
