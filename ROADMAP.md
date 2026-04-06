# FileFerry Roadmap

## Current — v0.3

- Everything in v0.2.1, plus:
- Modern OpenSSH algorithm support (rsa-sha2-256 / rsa-sha2-512)
- PEM key support (`.pem` files — common for AWS EC2)
- Host key verification warning
- SSH agent support (system agent + 1Password SSH agent)
- Keyboard-interactive auth (2FA / challenge-response)

## In Progress — v0.4 — Upload Reliability

- **Cancel all transfers** — cancellable progress notification with token forwarding
- **Folder upload** — recursive directory expansion from Explorer context menu
- **Upload on save** — auto-deploy with gitignore respect, status bar menu toggle
- **Editor keybindings** — `Alt+U` to upload, `Alt+P` to compare with remote from the editor
- Ignore patterns (gitignore-style globs in config or `.fileferryignore`)
- Atomic upload (temp file + rename, prevents partial state)
- File date guard (warn if remote file is newer than local)

---

## Previous Releases

### v0.2.1

- Upload git-changed or Explorer-selected files via SFTP
- Delete remote files that were locally deleted
- Compare with remote (diff view)
- Multi-server support with per-project binding (`.vscode/fileferry.json`)
- SSH credentials stored securely in the OS keychain
- Upload confirmation flow
- Status bar showing active server
- **Remote File Browser** — sidebar panel to browse remote filesystem with path indicator
- **Servers panel** — see all configured servers, click to switch
- **Welcome views** — onboarding guidance for new users
- **Download to Workspace** — download remote files to mapped local paths
- **Compare with Local** — diff remote files against local versions
- **Delete from Server** — delete remote files and folders with confirmation
- **Copy Remote Path** — copy any remote path to clipboard
- **Reconnect from error state** — click error items to retry or open settings
- **Context menus** — right-click actions for all remote browser operations

---

## Upcoming

### v0.5 — Multi-Target & Remote Operations

- Project-scoped server configs — servers defined per-project in `fileferry.json`, so teammates can share server setups without extra configuration. Credentials stay secure in your OS keychain.
- Push to multiple servers simultaneously (dev + staging + prod in one action)
- Test connection command
- Backup before overwrite (download remote version before replacing)

### v0.6 — Protocol & Filesystem

- Symlink and hidden file support
- FTP / FTPS support

### v0.7 — SSH Power Features

- SSH connection hopping (jump hosts)
- Full `~/.ssh/config` support (ProxyCommand, wildcard Host blocks)
- Open SSH terminal to active server

### v0.8 — Sync Modes

- Local→remote, remote→local, and bidirectional sync
- File and directory permission control
- Concurrency control
- Remote time offset (clock skew compensation)

### v0.9 — Automation

- File system watcher (auto-upload on change, configurable glob patterns)
- Batch deploy from branch diff (all files changed between two branches)
- Pre/post deploy hooks (local shell or remote SSH command)
- Dry run mode

### v0.10 — History & Safety

- Upload history panel (filterable log of all deploy operations)

### v1.0 — Stable Release

- Documentation, marketplace screenshots, performance audit

---

Feedback and feature requests welcome via [GitHub Issues](https://github.com/emrah-isik/fileferry-vscode/issues).
