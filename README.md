# FileFerry

Deploy files from VS Code to remote servers over SFTP, FTP, or FTPS — without leaving the editor.

Right-click changed files in the Source Control panel, press `Alt+U`, confirm, done. No config file juggling, no manual path entry — just deploy what git knows you changed.

**Built on these principles:**

- **Deploy what changed** — git-aware upload works from the Source Control panel; deploy exactly the files you edited, nothing more
- **Credentials never on disk** — passwords and keys live in the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret); your `.vscode/fileferry.json` is safe to commit
- **Confirm before every deploy** — no silent uploads; you always see what will be sent before it goes
- **Full visibility** — dry run mode, upload history, and file date guard mean you always know what happened and why
- **Modern SSH** — works with OpenSSH 8.8+, 1Password agent, PEM keys, and keyboard-interactive 2FA out of the box

---

## Upload changed files

Select files in the Source Control panel, right-click, and deploy. Or press `Alt+U` — no mouse needed.

![SCM context menu](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_scm_context_menu.png)

FileFerry shows a confirmation before every deploy. Upload to multiple servers at once with `Shift+Alt+U`.

![Upload confirmation](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_scm_upload_confirmation.png)

- **Multi-select upload** — select any number of files in Source Control or Explorer
- **Multi-server push** — deploy to dev, staging, and prod in one action
- **Folder upload** — right-click a folder in Explorer to upload its contents recursively
- **Upload on save** — auto-deploy on file save, toggled from the status bar
- **Delete deployment** — git-deleted files appear in Source Control; deploying removes them from the server
- **Dry run mode** — preview exactly what would be uploaded without touching the server
- **Atomic upload** — files land as a temp file and are renamed on completion, no partial states
- **Backup before overwrite** — optionally download the remote version before replacing it
- **File date guard** — warns before overwriting a remote file newer than your local copy

---

## Browse and manage remote files

A dedicated sidebar panel lets you browse, download, compare, and delete files directly on the server.

![Remote Files panel](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_remote_files_panel.png)

- **Remote File Browser** — expandable directory tree with persistent connection and idle timeout
- **Compare with Remote** — side-by-side diff of local vs server version (`Alt+P`)
- **Compare with Local** — right-click a remote file to diff against the local counterpart
- **Download to Workspace** — right-click a remote file to download it to the mapped local path
- **Delete from Server** — right-click to delete with confirmation
- **Copy Remote Path** — copy any remote path to clipboard

---

## Simple configuration

Manage servers and credentials through a form — no JSON editing required.

![Deployment Settings](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_deployment_settings_panel.png)

- **Multiple servers** — define production, staging, and dev servers; switch with one click
- **Path mappings** — map workspace subfolders to different remote paths per server
- **File and directory permissions** — set octal permissions (`0644`, `0755`) on uploaded files
- **Remote time offset detection** — automatically corrects clock skew when comparing timestamps
- **Excluded paths** — glob patterns to skip files that should never be deployed
- **Clone server** — duplicate an existing server config as a starting point

---

## Secure credential storage

Passwords and passphrases are stored in the OS native keychain (macOS Keychain, Windows Credential Manager, Linux libsecret) — never written to disk or committed to git.

Supported auth methods: password, private key, SSH agent (including 1Password), and keyboard-interactive (2FA).

`.vscode/fileferry.json` stores server references and path mappings — no secrets. It is safe to commit.

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

This file is created and managed by FileFerry — you do not need to edit it manually.

---

## Upload history

Every deploy is logged. Filter by server, result, or file path.

![Upload History](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_upload_history.png)

---

## Status bar

The active server is always visible. Click to switch servers, toggle upload on save, enable dry run, or open upload history.

![Status bar](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_status_bar_item.png)
![Status bar menu](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_status_bar_command_list.png)

---

## Quick Start

1. Install FileFerry from the marketplace
2. Open `Ctrl+Shift+P` → `FileFerry: Deployment Settings`
3. Add a credential — click **Manage...** next to the credential dropdown
4. Add a server and configure path mappings
5. Go to the Source Control panel, select changed files, press `Alt+U`

---

## Keyboard Shortcuts

| Key | Action |
| --- | ------ |
| `Alt+U` | Upload selected files |
| `Alt+P` | Compare with Remote |
| `Shift+Alt+U` | Upload to multiple servers |

Configurable via `Preferences → Keyboard Shortcuts` → search `fileferry`.

---

## Troubleshooting

**"No project binding found"** — Open Deployment Settings and configure a server for this project.

**"Default server not found"** — The server in `.vscode/fileferry.json` no longer exists. Open Deployment Settings and save again.

**"Authentication failed"** — Open Credentials Manager, edit the credential, and re-enter the password.

**Upload goes to the wrong path** — Check path mappings. The most specific (longest) matching local path wins.

**SSH key not working** — Permissions must be `600`: `chmod 600 ~/.ssh/id_rsa`.

**Keychain not working on Linux** — Install `libsecret`: `sudo apt install libsecret-1-0`.

> FileFerry can overwrite or delete remote files. Always verify your configuration before deploying to a production server.

---

## Requirements

- VS Code 1.85 or later
- An SFTP or FTP-capable remote server
- For private key auth: an SSH key pair (`ssh-keygen`)
- For SSH agent auth: `ssh-agent` running with your key added (`ssh-add`)
- On Linux: `libsecret` for OS keychain support

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

---

## License

GPL-3.0-or-later — see [LICENSE](LICENSE)
