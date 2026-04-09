# FileFerry User Guide

This guide walks through how to use FileFerry, from first-time setup to advanced features.

For a quick overview, see the [README](../README.md).

---

## Table of Contents

- [Getting Started](#getting-started)
- [Uploading Files](#uploading-files)
- [Multi-Server Push](#multi-server-push)
- [File Permissions](#file-permissions-sftp--ftp)
- [Browsing Remote Files](#browsing-remote-files)
- [Comparing Files](#comparing-files)
- [Downloading Files](#downloading-files)
- [Deleting Remote Files](#deleting-remote-files)
- [Backup and Safety](#backup-and-safety)
- [Project Settings](#project-settings)
- [Path Mappings and Exclusions](#path-mappings-and-exclusions)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Commands Reference](#commands-reference)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### 1. Create a Credential

Open the command palette (`Ctrl+Shift+P`) and run `FileFerry: Manage SSH Credentials`.

Click **Add Credential** and fill in the details:

| Auth Method | What you need | Protocols |
| --- | --- | --- |
| Password | Host, port, username, password | SFTP, FTP, FTPS |
| Private Key | Host, port, username, path to key file, passphrase (optional) | SFTP only |
| SSH Agent | Host, port, username (uses your running `ssh-agent`) | SFTP only |
| Keyboard Interactive | Host, port, username (server sends 2FA challenges) | SFTP only |

**FTP/FTPS note:** FTP and FTPS protocols only support password authentication. When you select an FTP protocol in Deployment Settings, the credential dropdown automatically filters to show only password-auth credentials.

Passwords and passphrases are stored in your OS keychain (macOS Keychain / Windows Credential Manager / Linux libsecret). They are never written to disk or included in project files.

### 2. Add a Deployment Server

Open `FileFerry: Deployment Settings` from the command palette.

In the **Connection** tab:

1. Give the server a name (e.g. "Production" or "Staging")
2. Select the protocol: **SFTP** (recommended), **FTP**, **FTPS (Explicit TLS)**, or **FTPS (Implicit TLS)**
3. Pick the credential you just created (FTP/FTPS only shows password-auth credentials)
4. Set the **Root Path** to the base directory on the server (e.g. `/var/www`)

Click **Save**. Use **Test Connection** to verify everything works before deploying.

### 3. Configure Path Mappings

Switch to the **Mappings** tab to control how local paths map to remote paths.

If your project structure maps 1:1 to the server, you can skip this — files will deploy directly to the root path. Otherwise, add mapping rows:

| Local Path | Remote Path | Example result |
| --- | --- | --- |
| `/` | `html` | `src/app.php` -> `/var/www/html/src/app.php` |
| `/public` | `public_html` | `public/index.php` -> `/var/www/public_html/index.php` |

More specific paths (longer prefix) take priority.

### 4. Your First Upload

1. Make a change to any file in your project
2. Open the **Source Control** panel
3. Select the changed file(s)
4. Press `Alt+U` or right-click and choose **FileFerry: Upload**
5. Review the confirmation summary, then confirm

That's it. The file is now on the server.

---

## Uploading Files

There are several ways to upload files, depending on where you are in VS Code.

### From the Source Control Panel

This is the most common workflow. Changed files appear in the SCM panel. Select one or more files and:

- Press `Alt+U`, or
- Right-click and choose **FileFerry: Upload**

FileFerry detects whether each file was modified or deleted. Modified files are uploaded; deleted files are removed from the server (with an extra confirmation prompt).

### From the Explorer Panel

Right-click any file or folder in the Explorer tree and choose **FileFerry: Upload**. This works for any file, not just git-changed ones.

When you select a folder, FileFerry recursively uploads all files inside it, respecting your excluded paths.

### From the Editor

With a file open in the editor, press `Alt+U` to upload it directly.

### Upload on Save

Enable this in **Project Settings** (`FileFerry: Project Settings`) to automatically upload files every time you save. This respects your `.gitignore` — ignored files are never auto-uploaded.

Toggle it quickly from the status bar without opening settings.

### Upload Confirmation

Before every upload, FileFerry shows a summary of what will be uploaded and what will be deleted. You can review and confirm or cancel.

For upload-only deploys (no deletions), you can check "don't ask again" to skip the prompt for that server. Deletion deploys always show the confirmation regardless.

To re-enable prompts, run `FileFerry: Reset Upload Confirmations`.

### Atomic Upload

FileFerry uploads to a temporary file first, then renames it to the final path. This prevents partial or corrupted files on the server if the connection drops mid-transfer.

---

## Multi-Server Push

Upload to multiple servers in a single action — useful when you want to deploy to dev, staging, and production at once.

1. Select files in the Source Control or Explorer panel
2. Right-click and choose **FileFerry: Upload to Servers...**
3. Pick which servers to push to from the list
4. Confirm the upload

All selected servers receive the files simultaneously. Each server uses its own path mappings and root path.

---

## Browsing Remote Files

Click the **FileFerry icon** in the activity bar to open the sidebar. It has two panels:

### Remote File Browser

Browse your remote server's filesystem. Click directories to expand them, click files to open them in the editor.

Features:

- File type icons match your VS Code icon theme
- Persistent connection with automatic idle timeout
- Path indicator shows your current location
- Use `FileFerry: Go to Remote Path` to jump to a specific directory
- Use `FileFerry: Disconnect Remote Browser` to close the connection

### Servers Panel

See all configured servers at a glance. The active server shows a filled circle indicator.

- Click a server to switch to it
- Right-click for options: **Edit Server**, **Test Connection**

---

## Comparing Files

### Local vs Remote (from Source Control or Editor)

Select a file and press `Alt+P` or right-click and choose **FileFerry: Compare with Remote**. This opens VS Code's diff editor showing your local version on the left and the server version on the right.

### Remote vs Local (from Remote File Browser)

Right-click a file in the Remote File Browser and choose **Compare with Local**. Same diff view, initiated from the remote side.

---

## Downloading Files

Right-click a file in the Remote File Browser and choose **Download to Workspace**.

- If the file's remote path matches a path mapping, it downloads to the corresponding local path
- If no mapping matches, FileFerry prompts you to choose a save location

---

## Deleting Remote Files

### Deploying Deleted Files

When you delete a file locally, it appears as deleted in the Source Control panel. Select it and press `Alt+U`. FileFerry will:

1. Detect that the file no longer exists on disk
2. Show a confirmation listing what will be deleted — **always shown**, regardless of "don't ask again"
3. Remove the file from the server after you confirm

### Deleting from the Remote File Browser

Right-click a file or folder in the Remote File Browser and choose **Delete from Server**. A confirmation prompt always appears before deletion.

---

## Backup and Safety

### Dry Run Mode

Enable dry run mode to preview exactly what would be uploaded or deleted — without actually transferring anything. No connections are opened; no files are moved.

When dry run is on:
- The **FileFerry output channel** shows a structured plan listing every file that would be uploaded (with local → remote paths) and every remote path that would be deleted, grouped by server.
- A notification appears with the total count and a **Show Log** button.
- **Upload on save is silently skipped** — no notification, no log line.
- The status bar changes to `$(eye) ServerName — DRY RUN` so you can't forget the mode is active.

**Note:** FileDateGuard results are not shown in dry run output — that check requires a remote connection and dry run is purely local.

Enable or disable dry run in any of these places:
- **Project Settings** — `FileFerry: Project Settings` from the command palette
- **Status bar menu** — click the FileFerry status bar item and choose **Dry Run Mode**

### Backup Before Overwrite

When enabled, FileFerry downloads the existing remote file before uploading your new version. Backups are stored in `.vscode/fileferry-backups/` in your workspace.

Enable this in **Project Settings** (`FileFerry: Project Settings`).

### File Date Guard

FileFerry checks if the remote file is newer than your local copy before uploading. If it is, you'll see a warning so you can compare before overwriting someone else's changes.

### Excluded Paths

Set glob patterns in the Mappings tab to skip files that should never be uploaded. Common patterns:

```
node_modules, *.log, .env, .git, vendor
```

### Ignore Patterns

Similar to `.gitignore`, these patterns prevent matching files from being deployed. If you try to upload a file that matches an ignore pattern, FileFerry will ask if you want to force-upload it.

---

## Project Settings

Open with `FileFerry: Project Settings` from the command palette.

This is a per-project settings panel for toggling features that apply to the current workspace:

- **Dry run mode** — preview what would be deployed without transferring any files
- **Upload on save** — auto-deploy files when you save
- **Backup before overwrite** — download remote files before replacing them

These settings are stored in `.vscode/fileferry.json` alongside your server bindings.

### Root Path Override

In the Mappings tab of Deployment Settings, you can override a server's root path for the current project. This lets you reuse the same server definition across projects that deploy to different directories.

### Sharing Config with Teammates

`.vscode/fileferry.json` contains no secrets — only server IDs, path mappings, and project settings. It's safe to commit to git. Each teammate will need to set up credentials on their own machine, but the server configuration and mappings will be shared.

---

## Path Mappings and Exclusions

### How Mappings Work

Mappings translate local workspace paths to remote server paths. Each mapping has a local path (relative to your workspace root) and a remote path (relative to the server's root path).

**Example:** With root path `/var/www` and this mapping:

| Local Path | Remote Path |
| --- | --- |
| `/src` | `app/src` |

The local file `src/index.php` uploads to `/var/www/app/src/index.php`.

### Priority

When multiple mappings match a file, the most specific (longest) local path wins.

### No Mappings

If no mappings are configured, all files map directly to the server root path. A local file `src/index.php` with root path `/var/www` uploads to `/var/www/src/index.php`.

### Excluded Paths

Comma-separated glob patterns set in the Mappings tab. Files matching these patterns are silently skipped during upload. Use this for files that should never be deployed: `node_modules, *.log, .env`.

---

## Keyboard Shortcuts

| Key | Action | Context |
| --- | --- | --- |
| `Alt+U` | Upload selected files | Source Control, Explorer, or Editor |
| `Alt+P` | Compare with Remote | Source Control or Editor |

Customize via `Preferences -> Keyboard Shortcuts` and search for `fileferry`.

---

## Commands Reference

| Command | Description |
| --- | --- |
| `FileFerry: Upload` | Upload selected files (SCM, Explorer, or Editor) |
| `FileFerry: Upload to Servers...` | Upload selected files to multiple servers |
| `FileFerry: Compare with Remote` | Diff local file against the server version |
| `FileFerry: Deployment Settings` | Open server and mapping configuration |
| `FileFerry: Project Settings` | Open project-level toggles |
| `FileFerry: Manage SSH Credentials` | Add, edit, or delete credentials |
| `FileFerry: Switch Server` | Change the default server for this project |
| `FileFerry: Go to Remote Path` | Navigate the Remote File Browser to a path |
| `FileFerry: Disconnect Remote Browser` | Close the remote browser connection |
| `FileFerry: Reset Upload Confirmations` | Re-enable upload prompts |
| `FileFerry: Test Connection` | Verify server credentials |
| `Download to Workspace` | Download a remote file to the mapped local path |
| `Compare with Local` | Diff a remote file against the local version |
| `Delete from Server` | Delete a remote file or folder (with confirmation) |
| `Copy Remote Path` | Copy the full remote path to clipboard |

---

## Troubleshooting

### "No project binding found"

You haven't configured a server for this project yet. Open **Deployment Settings**, add or select a server, configure path mappings, and save.

### "Default server not found"

The server saved in `.vscode/fileferry.json` no longer exists in your global config. Open **Deployment Settings** and save the configuration again.

### "Authentication failed"

Your saved credential may be stale or incorrect. Open **Manage SSH Credentials**, edit the credential, and re-enter the password or passphrase.

### "No such file" on upload

FileFerry creates missing remote directories automatically. If this still fails, check that your user has write permission on the remote path.

### Upload or compare goes to the wrong path

Check your path mappings in **Deployment Settings**. The most specific (longest) matching local path wins. If no mappings are set, files map directly to the server root.

### SSH key not working

Key file permissions must be `600`:

```bash
chmod 600 ~/.ssh/id_rsa
```

SSH rejects keys with loose permissions. FileFerry will warn you when saving a key credential with incorrect permissions.

### Remote File Browser shows an error

Click the error item to retry the connection, or check your server configuration in **Deployment Settings**. If the server is unreachable, verify the host, port, and credentials.

### Upload on save not working

Make sure it's enabled in **Project Settings**. Files in your `.gitignore` are never auto-uploaded. Check that the file you're saving isn't excluded by your ignore patterns.
