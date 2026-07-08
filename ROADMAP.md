# FileFerry Roadmap

## Current — v0.10

- Everything in v0.9, plus:
- Sync to Remote — mirror your entire mapped local tree to the server in one action; uploads new and locally-newer files, with opt-in "delete extras" to prune remote files that no longer exist locally
- Sync Folder to Remote — the same mirror scoped to one or more right-clicked Explorer folders
- Delete-extras safety — off by default, with a dry-run preview, a modal confirmation naming the exact delete count, deletes restricted to the mapped remote root, exclude-aware pruning, and an opt-in backup of each deleted file

---

## Previous Releases

### v0.9

- Upload only newer (smart sync) — skips any file whose remote copy is the same age or newer, so re-running a deploy only pushes what moved forward
- Watch & auto-upload — opt-in file-system watcher for build outputs and other generated files that never fire an editor save
- Upload History source tracking — a Source column and filter (Manual / On Save / Multi-Server / Watch / Sync)

### v0.8

- Changed Files view — FileFerry-owned tree of git-changed files with native keyboard multi-select upload (`Alt+U`)
- Upload All Changed Files — `Ctrl+Alt+U` deploys everything git considers changed; no selection required
- Upload Files from Commit — pick one or more recent commits and deploy the working-tree version of every file they touched
- `~/.ssh/config` support — reference a `Host` alias and FileFerry resolves HostName, Port, User, and IdentityFile at connect time
- Documentation, `fileferry.json` schema reference, and marketplace polish

### v0.7

- File and directory permission control (set octal mode on uploaded files and created directories)
- Remote time offset — clock skew compensation so file date guard works correctly against servers with unsynchronised clocks
- Dry run mode — preview exactly what would be uploaded or deleted without transferring any files
- Upload history panel — persistent, filterable log of all deploy operations per project

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

### v0.11 — Automation

- Pre/post deploy hooks (local shell or remote SSH command)
- Batch deploy from branch diff (all files changed between two branches)

### v0.12 — SSH Power Features

- SSH connection hopping (jump hosts), including `ProxyCommand` / `ProxyJump` from `~/.ssh/config`
- Open SSH terminal to active server

### Later

- Writable Remote Files panel — edit-in-place and create files/folders directly in the Remote File Browser
- Additional sync directions — remote→local and bidirectional sync (v0.10 shipped the one-way local→remote mirror)

---

Feedback and feature requests welcome via [GitHub Issues](https://github.com/emrah-isik/fileferry-vscode/issues).
