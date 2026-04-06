# FileFerry

![FileFerry](resources/readme-banner.png)

Fast remote file deployment and management for VS Code.

FileFerry lets you upload, download, browse, compare, and manage files between your local workspace and remote servers over **SFTP** or **FTP**, without leaving the editor.

If you came from PhpStorm and miss its deployment workflow, FileFerry gives you exactly that experience: right-click changed files in the SCM panel, press `Alt+U`, done.

> **Be careful:** FileFerry can overwrite or delete remote files. Always test your setup on a safe target first.

---

## Why FileFerry?

FileFerry is built for developers who want a simple, direct workflow for remote file operations.

It works well for:

- small deployments
- shared hosting workflows
- remote maintenance
- quick file sync tasks
- projects where a full CI/CD setup would be overkill

---

## Features

### Deploy

- **Multi-select upload** — select multiple files in Source Control, press `Alt+U` to upload them all at once
- **Multi-server push** — upload to multiple servers simultaneously (dev + staging + prod in one action)
- **Folder upload** — recursive directory upload from the Explorer context menu
- **Upload on save** — auto-deploy with gitignore respect, toggled from the status bar
- **Atomic upload** — temp file + rename prevents partial file states on the server
- **Backup before overwrite** — automatically downloads the remote version before replacing it
- **File date guard** — warns before overwriting a remote file that is newer than your local copy
- **Delete deployment** — git-deleted files appear in Source Control; deploying them removes them from the server with a mandatory confirmation prompt
- **Upload confirmation** — summary before every deploy; "don't ask again" per server for upload-only deploys (always shown when deleting files)

### Browse and Compare

- **Remote File Browser** — dedicated sidebar panel to browse your remote server's filesystem. Expand directories, click any file to view it in the editor. Persistent connection with automatic idle timeout
- **Compare with Remote** — open a side-by-side diff of your local file vs the version on the server (`Alt+P`)
- **Compare with Local** — right-click a remote file to diff it against the corresponding local file
- **Download to Workspace** — right-click a remote file to download it to the mapped local path
- **Copy Remote Path** — right-click any remote item to copy its full path to clipboard
- **Delete from Server** — right-click a remote file or folder to delete it with confirmation

### Configuration

- **PhpStorm-style settings UI** — manage servers and path mappings through a form, not JSON
- **Project settings** — dedicated panel for project-level toggles (upload on save, auto-backup, etc.)
- **Multiple servers** — production, staging, dev — switch with `FileFerry: Switch Server` or click the status bar
- **Clone server** — duplicate an existing server config as a starting point
- **Path mappings** — map workspace subfolders to different remote paths per server
- **Root path override** — override a server's root path per project without changing the global server definition
- **Excluded paths** — glob patterns to skip files that should never be deployed
- **Ignore patterns** — gitignore-style glob exclusions with force-upload prompt

### Credentials

- **SSH Credentials Manager** — add credentials once, reuse across projects
- **OS keychain security** — passwords and passphrases stored in macOS Keychain / Windows Credential Manager / Linux libsecret. Never written to disk
- **SSH agent support** — works with system agent and 1Password SSH agent
- **Servers panel** — see all configured servers at a glance. Active server shows a filled circle; click any server to switch

---

## Quick Start

1. Install FileFerry from the marketplace
2. Open a project with a `.git` folder
3. Open **Deployment Settings**: `Ctrl+Shift+P` → `FileFerry: Deployment Settings`
4. Add a Credential (click **Manage...** next to the credential dropdown). SFTP with SSH keys is recommended
5. Add a Deployment Server and configure path mappings
6. Press `Alt+U` in the Source Control panel to upload selected files — or right-click → **FileFerry: Upload**
7. Click the **FileFerry icon** in the activity bar to browse remote files and manage servers

For full documentation, see [GUIDE.md](./docs/GUIDE.md).

---

## Settings UI

### Deployment Settings (`Ctrl+Shift+P` → `FileFerry: Deployment Settings`)

Two-panel layout — server list on the left, details on the right.

#### Connection tab

| Field | Description |
| ----- | ----------- |
| Name | Display name for this server |
| Protocol | SFTP (recommended) or FTP |
| SSH Credential | Pick from your saved credentials |
| Root Path | Base path on the remote server (e.g. `/var/www`) |

#### Mappings tab

Optionally override the root path for this project only, then add rows to map local workspace paths to remote paths:

| Local Path | Remote Path | Result |
| ---------- | ----------- | ------ |
| `/` | `html` | `src/app.php` → `/var/www/html/src/app.php` |
| `/public` | `public_html` | `public/index.php` → `/var/www/public_html/index.php` |

More specific paths (longer prefix) take priority. If no mappings are configured, all files map directly to the server root. Excluded Paths accepts comma-separated glob patterns — e.g. `node_modules, *.log, .env`.

### SSH Credentials (`Ctrl+Shift+P` → `FileFerry: Manage SSH Credentials`)

| Auth Method | Extra Fields | Secret Storage |
| ----------- | ------------ | -------------- |
| Password | — | Password → OS keychain |
| Private Key | Key file path | Passphrase (if any) → OS keychain |
| SSH Agent | — | Uses `ssh-agent` / Pageant — no storage |

Passwords are never written to disk. Leave the password field blank when editing a credential to keep the existing stored value.

---

## Project Binding

Each project stores its server selection and path mappings in `.vscode/fileferry.json`. This file contains **no secrets** — it only stores server IDs, path mappings, and exclusion patterns.

```json
{
  "defaultServerId": "a1b2c3d4-...",
  "servers": {
    "a1b2c3d4-...": {
      "mappings": [
        { "localPath": "/", "remotePath": "html" }
      ],
      "excludedPaths": ["node_modules", "*.log", ".env"]
    }
  }
}
```

It is safe to commit `.vscode/fileferry.json` to git. SSH credentials are global and stored separately.

---

## Keyboard Shortcuts

| Key | Action | When |
| --- | ------ | ---- |
| `Alt+U` | Upload selected files | Source Control or Editor focused |
| `Alt+P` | Compare with Remote | Source Control or Editor focused |

Configurable via `Preferences → Keyboard Shortcuts` → search `fileferry`.

---

## Commands

| Command | Description |
| ------- | ----------- |
| `FileFerry: Upload` | Upload selected files (SCM panel or Explorer right-click) |
| `FileFerry: Upload to Servers...` | Upload selected files to multiple servers |
| `FileFerry: Compare with Remote` | Diff local file against the server version |
| `FileFerry: Deployment Settings` | Open server and mapping configuration |
| `FileFerry: Project Settings` | Open project-level settings (upload on save, auto-backup, etc.) |
| `FileFerry: Manage SSH Credentials` | Add, edit, or delete SSH credentials |
| `FileFerry: Switch Server` | Change the default server for this project |
| `FileFerry: Go to Remote Path` | Navigate the Remote File Browser to a specific path |
| `FileFerry: Disconnect Remote Browser` | Close the remote browser connection |
| `Download to Workspace` | Download a remote file to the mapped local workspace path |
| `Compare with Local` | Diff a remote file against the corresponding local file |
| `Delete from Server` | Delete a remote file or folder (with confirmation) |
| `Copy Remote Path` | Copy the full remote path to clipboard |
| `FileFerry: Test Connection` | Verify server credentials |
| `FileFerry: Reset Upload Confirmations` | Re-enable upload prompts suppressed by "don't ask again" |

---

## Deploying Deleted Files

When you delete a file it appears in the Source Control panel as deleted. Select it and press `Alt+U` (or right-click → `FileFerry: Upload`). FileFerry will:

1. Detect that the file no longer exists on disk
2. Show a confirmation listing what will be uploaded and what will be deleted — **always shown for deletions**, regardless of "don't ask again"
3. Remove the file from the remote server after confirmation

---

## Troubleshooting

### "No project binding found"

Open Deployment Settings, configure a server and path mappings for this project.

### "Default server not found"

The server saved in `.vscode/fileferry.json` no longer exists. Open Deployment Settings and save the server configuration again.

### "Authentication failed"

Your saved credential may be stale. Open SSH Credentials Manager, edit the credential, and re-enter the password.

### "No such file" on upload

FileFerry creates missing remote directories automatically. If this still fails, check that your username has write permission on the remote path.

### Upload or compare goes to the wrong path

Check the path mappings in Deployment Settings. The most specific (longest) matching local path wins. If no mappings are set, all files map directly to the server root.

### SSH key not working

Key file permissions must be `600`: `chmod 600 ~/.ssh/id_rsa`. SSH rejects keys with loose permissions. FileFerry will warn you when saving a key credential with wrong permissions.

---

## Safety

FileFerry is designed for convenience, but remote file operations can be destructive.

Before using it on a real server:

- verify the remote host and root path
- verify the local root path
- test with a non-critical file first
- use a staging server before production when possible
- keep backups
- double-check before deleting or overwriting files

**Remote deletions should always be treated as high-risk actions.**

---

## Security

- All secrets (passwords, passphrases) stored in the **OS native keychain** — never on disk
- `.vscode/fileferry.json` contains no secrets and is safe to commit
- Webview panels receive credential lists **without** secret fields — passwords only travel to the extension on explicit Save/Test actions
- Private key file permission check warns when key is world-readable (`644` instead of `600`)
- **SFTP is strongly recommended.** FTP is less secure and may expose credentials or file contents on untrusted networks

---

## Privacy

FileFerry does not send telemetry, analytics, or usage tracking data.

The extension only connects to the remote servers that you explicitly configure.

---

## Requirements

- VS Code 1.85 or later
- An SFTP or FTP-capable remote server
- For private key auth: an SSH key pair (`ssh-keygen`)
- For agent auth: `ssh-agent` running with your key added (`ssh-add`)
- On Linux: `libsecret` for OS keychain support (usually pre-installed on desktop distributions)

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a list of changes in each release.

---

## License

GPL-3.0-or-later — see [LICENSE](LICENSE)

---

## Disclaimer

FileFerry can upload, overwrite, download, and delete files on remote servers. **Use it at your own risk.** Always verify your configuration, test carefully, and keep backups. This software is provided without warranties or guarantees of any kind.
