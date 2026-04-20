# FileFerry Roadmap

## Current — v0.7

- Everything in v0.6, plus:
- File and directory permission control (set octal mode on uploaded files and created directories)
- Remote time offset — clock skew compensation so file date guard works correctly against servers with unsynchronised clocks
- Dry run mode — preview exactly what would be uploaded or deleted without transferring any files
- Upload history panel — persistent, filterable log of all deploy operations per project

---

## Previous Releases

### v0.6

- Symlink directory support in the Remote File Browser and directory picker
- FTP / FTPS support (plain FTP, explicit TLS, implicit TLS)
- Protocol-agnostic TransferService abstraction — all features work across SFTP and FTP
- Credential filtering — FTP protocols only show password-auth credentials

### v0.5

- Project-scoped server configs — servers defined per-project in `fileferry.json`
- Push to multiple servers simultaneously (dev + staging + prod in one action)
- Project settings UI for per-project toggles
- Backup before overwrite (download remote version before replacing)

### v0.4

- Upload on save with gitignore respect
- Folder upload from Explorer context menu
- Atomic upload (temp file + rename)
- Ignore patterns (gitignore-style glob exclusions)
- File date guard (warn if remote is newer)
- Cancel all transfers

### v0.3

- Modern OpenSSH algorithm support (rsa-sha2-256 / rsa-sha2-512)
- PEM key support (`.pem` files — common for AWS EC2)
- Host key verification warning
- SSH agent support (system agent + 1Password SSH agent)
- Keyboard-interactive auth (2FA / challenge-response)

### v0.2.1

- Remote File Browser — sidebar panel to browse remote filesystem
- Servers panel — see all configured servers, click to switch
- Download to Workspace, Compare with Local, Delete from Server
- Copy Remote Path, context menus, reconnect from error state

### v0.1

- SCM panel integration, Explorer upload, multi-select upload
- SFTP upload with password, private key, or SSH agent auth
- Compare with Remote (diff view)
- Multiple servers, path mappings, excluded paths
- SSH Credentials Manager with OS keychain storage

---

## Upcoming

### v0.8 — Stable Release

- Documentation, marketplace screenshots, demo GIFs
- Performance audit
- `fileferry.json` schema documentation
- **Upload All Changed Files** — `Ctrl+Alt+U` deploys everything git considers changed to the default server; SCM title bar button; no selection required

### v0.9 — Sync & Performance

- Bidirectional sync (local→remote, remote→local, conflict resolution)
- Concurrent file uploads (parallel connections)
- File system watcher (auto-upload on any file change, not just save)

### v0.10 — Automation

- Pre/post deploy hooks (local shell or remote SSH command)
- Batch deploy from branch diff (all files changed between two branches)

### v0.11 — SSH Power Features

- SSH connection hopping (jump hosts)
- Full `~/.ssh/config` support (ProxyCommand, wildcard Host blocks)
- Open SSH terminal to active server

---

Feedback and feature requests welcome via [GitHub Issues](https://github.com/emrah-isik/fileferry-vscode/issues).
