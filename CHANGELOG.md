# Changelog

All notable changes to FileFerry will be documented in this file.

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
