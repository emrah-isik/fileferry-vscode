# FileFerry

Deploy files from VS Code to remote servers over SFTP, FTP, or FTPS — without leaving the editor.

Right-click changed files in the Source Control panel and pick **FileFerry: Upload**, or open the **FileFerry → Changed Files** view, select files, and press `Alt+U`. No config file juggling, no manual path entry — just deploy what git knows you changed.

**Built on these principles:**

- **Deploy what changed** — git-aware upload from the FileFerry Changed Files view or the Source Control panel; deploy exactly the files you edited, nothing more
- **Credentials never on disk** — passwords and keys live in the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret); your `.vscode/fileferry.json` is safe to commit
- **Confirm before every deploy** — no silent uploads; you always see what will be sent before it goes
- **Full visibility** — dry run mode, upload history, and file date guard mean you always know what happened and why
- **Modern SSH** — works with your existing `~/.ssh/config` aliases, OpenSSH 8.8+, 1Password agent, PEM keys, and keyboard-interactive 2FA out of the box

---

## Coming from vscode-sftp?

If `vscode-sftp` stopped working on Ubuntu 22.04+, AWS EC2, or after a server upgrade, the cause is almost always missing modern OpenSSH algorithms (`rsa-sha2-256`, `ed25519`, `curve25519-sha256`). FileFerry supports them out of the box.

A few practical differences:

| Area | vscode-sftp | FileFerry |
| --- | --- | --- |
| Credentials | plaintext `sftp.json` in the workspace | OS keychain (Keychain / Credential Manager / libsecret) |
| Modern OpenSSH (8.8+) | manual algorithm config required | works by default |
| SSH agent (1Password, gpg-agent, Pageant) | partial | auto-detected |
| Git-aware uploads | not built-in | first-class — deploy from the Source Control panel |
| Project config in git | unsafe (contains secrets) | safe — `.vscode/fileferry.json` has no credentials |
| Active maintenance | last meaningful release 2022 | actively maintained |

Existing `sftp.json` files aren't auto-imported — set up your server once in FileFerry's Deployment Settings panel, and your credentials move to the keychain.

---

## Upload changed files

Two ways to deploy what you've changed:

- **SCM right-click** — select files in the Source Control panel, right-click → **FileFerry: Upload**.
- **Changed Files view** — open the FileFerry sidebar, focus the **Changed Files** view, select one or more files, press `Alt+U`. The view auto-refreshes as you edit.

![SCM context menu](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_scm_context_menu.png)

FileFerry shows a confirmation before every deploy. Upload to multiple servers at once with `Shift+Alt+U`.

![Upload confirmation](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_scm_upload_confirmation.png)

- **Multi-select upload** — Source Control right-click or the FileFerry **Changed Files** view; select any number of files and deploy in one action
- **Upload all changed files** — `Ctrl+Alt+U` deploys everything git considers changed, no selection required
- **Upload only what's newer** — a smart-sync variant that skips any file whose remote copy is the same age or newer, so re-running a deploy only pushes what actually moved forward (the `$(sync)` button on the Source Control title bar, and a history-icon button in the **Changed Files** view that adapts to your selection)
- **Upload from commit** — pick one or more recent commits and deploy every file they touched (working-tree version)
- **Multi-server push** — deploy to dev, staging, and prod in one action
- **Folder upload** — right-click a folder in Explorer to upload its contents recursively
- **Upload on save** — auto-deploy on file save, toggled from the status bar
- **Watch & auto-upload** — opt-in file-system watcher for build outputs and other generated files that never fire an editor save; matches an explicit glob allowlist and uploads even when git-ignored (configure under **Project Settings**)
- **Delete deployment** — git-deleted files appear in Source Control; deploying removes them from the server
- **Dry run mode** — preview exactly what would be uploaded without touching the server
- **Atomic upload** — files land as a temp file and are renamed on completion, no partial states
- **Backup before overwrite** — optionally download the remote version before replacing it
- **File date guard** — warns before overwriting a remote file newer than your local copy

---

## Sync your whole tree to the server

Beyond deploying individual changes, **FileFerry: Sync to Remote** mirrors your entire mapped local tree to the server in one action. It walks both trees and reconciles them: uploads new and locally-newer files, skips anything the remote already holds at the same age or newer, and — only when you opt in per run — deletes remote files that no longer exist locally.

- **Sync to Remote** — full-tree one-way mirror (local → remote), from the Command Palette or the status-bar menu
- **Sync Folder to Remote** — right-click any folder (or several) in the Explorer to mirror just that subtree
- **Delete extras is off by default** and wrapped in defense-in-depth: a dry-run-first preview of the full plan, a modal confirmation naming the exact delete count, deletes restricted to the mapped remote root (or the folders you right-clicked), and exclude-aware detection so `excludedPaths` / `.fileferryignore` files are never pruned
- **Back up before deletes** — an on-by-default project setting downloads each to-be-deleted file to `.vscode/fileferry-backups/` first
- `.git` and `node_modules` are always skipped; synced transfers appear in Upload History under a **Sync** source

---

## Run commands before and after a deploy

Give a server **deploy hooks** and FileFerry runs them around a deliberate deploy — build assets before upload, then reload a service or run migrations after.

- **Local or remote** — a local hook runs in your shell at the workspace root; a remote hook runs over the deploy's own SSH connection (SFTP only — on FTP it's skipped with a warning)
- **Safe by default** — hooks never run in an untrusted workspace, and the deploy confirmation names every command before anything executes. They only fire on deliberate deploys; upload-on-save and the watcher never run them
- **Predictable failure** — a failed pre-deploy hook aborts the deploy before anything is transferred; a failed post-deploy hook is reported without rolling back what already uploaded. Each hook can opt into **continue on error** and a **timeout**
- **Secrets stay out of git** — store a value once in the **Secrets** section and reference it as `${secret:NAME}`

### Keychain-backed secrets

Type a token once in the Hooks tab and FileFerry puts it in your **OS keychain**; the committed `fileferry.json` holds only a `${secret:NAME}` reference, so it stays safe to commit.

- Secrets are **per-project and machine-local** — a teammate cloning the repo re-enters them, and the Hooks tab flags any referenced secret that isn't set on this machine
- Resolution happens the moment a hook runs — dialogs, logs, and dry-run always show the unresolved `${secret:NAME}`, and values FileFerry resolved are masked as `••••` in the output
- Local hooks receive the value as an **environment variable**, so it never enters the command string
- A deploy **aborts before transferring anything** if a hook that would run references a missing secret — so a post-deploy migration can't be silently skipped after your files are already live
- Pasted a raw secret by mistake? The inline warning offers a one-click **Move to keychain** that stores it and rewrites the command for you

---

## Browse and manage remote files

A dedicated sidebar panel lets you browse, download, compare, and delete files directly on the server.

![Remote Files panel](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_remote_files_panel.png)

- **Remote File Browser** — expandable directory tree with persistent connection and idle timeout
- **Compare with Remote** — side-by-side diff of local vs server version (`Alt+P`). Identical files, and files differing only in line endings, are reported directly instead of opening an empty diff
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
- **Project settings** — per-project toggles for upload-on-save, file date guard, backup before overwrite, dry run, watch & auto-upload, and back up before sync deletes, separate from server config

---

## Secure credential storage

Passwords and passphrases are stored in the OS native keychain (macOS Keychain, Windows Credential Manager, Linux libsecret) — never written to disk or committed to git.

Supported auth methods: password, private key, SSH agent (including 1Password), and keyboard-interactive (2FA).

**`~/.ssh/config` aware** — tick "Resolve from `~/.ssh/config`" on a credential and reference a `Host` alias instead of a hostname; FileFerry reads HostName, Port, User, and IdentityFile from your SSH config at connect time (SFTP).

![SSH config resolution](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_ssh_config_resolve.png)

First-time SSH connections show the server's host-key fingerprint and prompt for trust (TOFU); if a previously-trusted key changes, FileFerry warns before connecting.

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

Every deploy is logged. Each entry records how it was triggered — **Manual**, **On Save**, **Multi-Server**, **Watch**, or **Sync** — shown in a **Source** column. Filter by server, result, source, or file path.

![Upload History](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_upload_history.png)

---

## Status bar

The active server is always visible. Click to switch servers, toggle upload on save, enable dry run, sync the whole tree to the remote, or open upload history.

![Status bar](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_status_bar_item.png)
![Status bar menu](https://raw.githubusercontent.com/emrah-isik/fileferry-vscode/main/resources/readme/fileferry_status_bar_command_list.png)

---

## Quick Start

1. Install FileFerry from the marketplace
2. Open `Ctrl+Shift+P` → `FileFerry: Deployment Settings`
3. Add a credential — click **Manage...** next to the credential dropdown
4. Add a server and configure path mappings
5. Open the FileFerry sidebar → **Changed Files**, select changed files, press `Alt+U` (or right-click changed files in the Source Control panel → **FileFerry: Upload**)

---

## Keyboard Shortcuts

| Key | Where | Action |
| --- | ----- | ------ |
| `Alt+U` | Active editor | Upload the file in the editor |
| `Alt+U` | FileFerry → Changed Files view | Upload the rows you have selected |
| `Alt+P` | Active editor | Compare current file with remote |
| `Shift+Alt+U` | Active editor | Upload to multiple servers |
| `Ctrl+Alt+U` | Anywhere | Upload all changed files |

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
