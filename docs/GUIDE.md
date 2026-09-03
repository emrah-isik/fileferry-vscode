# FileFerry User Guide

This guide walks through how to use FileFerry, from first-time setup to advanced features.

For a quick overview, see the [README](../README.md).

---

## Table of Contents

- [Getting Started](#getting-started)
- [Uploading Files](#uploading-files)
- [The Changed Files View](#the-changed-files-view)
- [Multi-Server Push](#multi-server-push)
- [Syncing to the Server](#syncing-to-the-server)
- [Deploy Hooks and Secrets](#deploy-hooks-and-secrets)
- [Browsing Remote Files](#browsing-remote-files)
- [Open SSH Terminal](#open-ssh-terminal)
- [Managing Remote Files](#managing-remote-files)
- [Comparing Files](#comparing-files)
- [Downloading Files](#downloading-files)
- [Deleting Remote Files](#deleting-remote-files)
- [Upload History](#upload-history)
- [Backup and Safety](#backup-and-safety)
- [Project Settings](#project-settings)
- [Path Mappings and Exclusions](#path-mappings-and-exclusions)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Commands Reference](#commands-reference)
- [Config File Reference](#config-file-reference)
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

**2FA / keyboard-interactive note:** challenges are not limited to the *Keyboard Interactive* method. If your server asks for a verification code after a key or password step (OpenSSH `AuthenticationMethods publickey,keyboard-interactive`), FileFerry shows the same input prompts for any credential type; for password credentials a plain `Password:` challenge is answered from your keychain first — and if the server rejects that stored password, FileFerry reconnects once and asks you directly. Dismissing a prompt cancels the connection.

Prompts only appear for connections you start yourself (a deploy, **Test Connection**, browsing, a manual save of a remote edit). Background connections — upload on save, the file watcher, the Remote Files panel drawing itself, `files.autoSave`-triggered remote-edit saves — never prompt: when they would need one they fail fast with a warning instead (see [Host key verification](#host-key-verification)). A keyboard-interactive credential therefore cannot be used by background uploads at all — those always need your answer.

**FTP/FTPS note:** FTP and FTPS protocols only support password authentication. When you select an FTP protocol in Deployment Settings, the credential dropdown automatically filters to show only password-auth credentials without jump hosts (jump-host chains are SSH tunnels — SFTP only).

Passwords and passphrases are stored in your OS keychain (macOS Keychain / Windows Credential Manager / Linux libsecret). They are never written to disk or included in project files.

#### Using your `~/.ssh/config` (SFTP only)

If you already have a working entry in `~/.ssh/config`, you can point a credential at it instead of re-typing the host, port, user, and key:

```text
Host prod
    HostName 203.0.113.10
    Port 2222
    User deploy
    IdentityFile ~/.ssh/prod_ed25519
```

Tick **Resolve from `~/.ssh/config`** on the credential, then enter the alias (`prod`) in the **Host** field. At connect time FileFerry reads your SSH config and fills in `HostName`, `Port`, `User`, and `IdentityFile`. You can leave Username and Private Key Path blank when the config provides them.

- **Config wins, your entries are the fallback.** A value in the matching `Host` block takes effect; anything the block omits falls back to what you typed. (If the block sets no `HostName`, the alias is used as the host.)
- **You always see what happened.** On **Save** and **Test Connection**, a summary shows the resolved target — e.g. `✓ Resolved "prod" → deploy@203.0.113.10:2222 · key ~/.ssh/prod_ed25519` — or warns when no `~/.ssh/config` exists or no `Host` block matched (in which case your entered values are used as-is). If a catch-all `Host *` block overrides a value you typed, that's called out too.
- **Supported directives:** `HostName`, `Port`, `User`, `IdentityFile`, with `*`/`?` wildcard `Host` patterns. `ProxyJump`/`ProxyCommand` are not resolved yet. SFTP only — FTP/FTPS ignore this setting.

#### Jump hosts (SFTP only)

If a server is only reachable through a bastion (jump host), configure the chain on the **target's credential**: each hop is itself a normal credential (host, user, auth method — password, key, agent, or keyboard-interactive), and the target credential lists the hops in order, first hop → last hop before the target.

Create the hop credential(s) first, then open the target credential and use the **Jump hosts** picker on the form: add hops from the dropdown, reorder them with the ↑/↓ buttons (the connection tunnels through them top-to-bottom), and remove one with ✕. The dropdown only offers credentials that can legally be a hop — chains are flat, so a credential that has jump hosts of its own is not offered, and a credential that others already use as a hop cannot be given hops itself (the form tells you who uses it). The same rules are enforced again when you save.

**Test Connection runs the whole chain** and, when it fails, names the hop that failed (`✗ Jump host bastion.example.com (hop 1) failed: …`) rather than leaving you guessing which login broke.

A credential that is in use cannot be deleted: if servers reference it, or other credentials use it as a jump host, Delete is blocked with a message naming them (e.g. *used as a jump host by: Production via bastion*) — reassign those first. Editing or deleting a credential also takes effect immediately: a pooled hop logged in with the old details is dropped, and an open Remote Files session using that credential disconnects so the next action reconnects with the new data.

At connect time FileFerry logs in to each hop in turn and tunnels the SFTP session through it (`[ssh] route: local → you@bastion:22 → you@target:22` in the output channel). Everything that opens an SSH connection uses the chain automatically — deploys, Test Connection, the Remote Files panel, remote-edit saves. Because several identities can prompt during one connect, every authentication input box is titled with who is asking (`SSH login: you@bastion:22`) — answer with **that** host's credentials, not the target's.

**MFA and the chain — what to expect.** Hop connections are *pooled*: the bastion login is kept alive and shared, so its password/OTP prompt is asked **once per idle window** (the pooled connection closes after 5 minutes unused), no matter how many sessions a deploy opens through it. `FileFerry: Disconnect Remote Browser` also closes pooled hops: idle ones immediately, ones still carrying a session (a running deploy) as soon as that session finishes — it never cuts a hop out from under live traffic. If a pooled hop drops unexpectedly while the Remote Files panel is browsing through it, the panel shows its **Disconnected** row; click it to reconnect (which will re-prompt the hop's MFA if it has one). The *target* still authenticates once per session — a deploy opens several sequential sessions, so a target that itself demands a one-time code will prompt for each (TOTP servers reject code reuse, so FileFerry cannot replay one code for you). Putting the MFA on the bastion is therefore the pleasant setup; MFA on the target works, but prompts more.

Every host in the chain gets the same [host key verification](#host-key-verification) as a direct connection — expect one trust prompt per hop on first use. Background connections (upload on save, the watcher) never prompt through a chain either: an unverified hop fails fast with the usual warning.

**Server-side requirement:** the bastion must allow TCP forwarding (OpenSSH: `AllowTcpForwarding yes`, and any `PermitOpen` rules must include the next host). If the forward is refused, the connection error names the hop that refused it.

FTP/FTPS cannot use jump hosts — a credential with hops is SFTP-only. Deployment Settings enforces this everywhere: the credential dropdown for an FTP/FTPS server hides chained credentials, saving such a combination is a validation error, and Test Connection refuses it before dialing.

### 2. Add a Deployment Server

Open `FileFerry: Deployment Settings` from the command palette.

In the **Connection** tab:

1. Give the server a name (e.g. "Production" or "Staging")
2. Select the protocol: **SFTP** (recommended), **FTP**, **FTPS (Explicit TLS)**, or **FTPS (Implicit TLS)**
3. Pick the credential you just created (FTP/FTPS only shows password-auth credentials without jump hosts)
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

Upload on save runs in the background, so it never shows connection prompts. If the server's host key isn't trusted yet — or the connection would need a 2FA/verification prompt — the save is not uploaded; instead a warning appears (*host not yet trusted or verification required*) with a **Test Connection** button. Verify the host once (Test Connection, or any manual deploy) and later saves upload silently. Other connection failures show a regular error notification.

### Upload All Changed Files

`Ctrl+Alt+U` (or **FileFerry: Upload All Changed Files** from the palette) deploys everything git considers changed to the default server — no selection needed.

### Upload Only If Newer

**FileFerry: Upload Changed Files (Only If Newer)** — the `$(history)` button on the Source Control title bar — is the smart-sync variant: before uploading, each file's remote timestamp is checked, and any file whose remote copy is the **same age or newer** is skipped (skips are listed in the output channel, not in history). Re-running a deploy only pushes what actually moved forward.

### Upload from Commits

**FileFerry: Upload Files from Commit** shows your recent commits; pick one or more and FileFerry uploads the **working-tree version** of every file those commits touched.

### Watch & Auto-Upload

For build outputs and other generated files that never fire an editor save, enable the opt-in file-system watcher in **Project Settings**: turn on **Watch & auto-upload** and list workspace-relative glob patterns (e.g. `dist/**`). Files matching the globs upload automatically when they change on disk — an explicit allowlist, so they upload **even when git-ignored** (unlike upload-on-save). Changes are debounced and batched, `excludedPaths` and the file date guard still apply, and watch uploads appear in Upload History under the **Watch** source. Watch uploads never run deploy hooks.

Like upload on save, the watcher never shows connection prompts: against a host that isn't trusted yet (or one that would need a verification prompt) the batch is skipped — each file is listed in the output channel, and one *host not yet trusted or verification required* warning with a **Test Connection** button appears per batch. Verify the host once and watching resumes silently.

### Upload Confirmation

Before every upload, FileFerry shows a summary of what will be uploaded and what will be deleted. You can review and confirm or cancel.

For upload-only deploys (no deletions), you can check "don't ask again" to skip the prompt for that server. Deletion deploys always show the confirmation regardless.

To re-enable prompts, run `FileFerry: Reset Upload Confirmations`.

### Atomic Upload

FileFerry uploads to a temporary file first, then renames it to the final path. This prevents partial or corrupted files on the server if the connection drops mid-transfer.

---

## The Changed Files View

The FileFerry sidebar has a **Changed Files** view — FileFerry's own tree of everything git considers changed, refreshed automatically as you edit.

- Select one or more rows (Ctrl/Shift-click) and press `Alt+U` to upload the selection — or press the `$(cloud-upload)` title button, which uploads your selection, or **all** changed files when nothing is selected.
- The `$(history)` title button is the **only-if-newer** variant of the same action: selection if you have one, everything otherwise, skipping files whose remote copy is the same age or newer.
- Right-click a row for **Upload** and **Compare with Remote**.

---

## Multi-Server Push

Upload to multiple servers in a single action — useful when you want to deploy to dev, staging, and production at once.

1. Select files in the Source Control or Explorer panel
2. Right-click and choose **FileFerry: Upload to Servers...**
3. Pick which servers to push to from the list
4. Confirm the upload

All selected servers receive the files simultaneously. Each server uses its own path mappings and root path.

---

## Syncing to the Server

Beyond deploying individual changes, FileFerry can mirror a whole tree to the server in one action.

### Sync to Remote

Run **FileFerry: Sync to Remote** (Command Palette or the status-bar menu). FileFerry walks your mapped local tree and the corresponding remote tree, reconciles them, and:

- **uploads** files that are new locally or newer than their remote copy,
- **skips** files the remote already holds at the same age or newer,
- optionally **deletes remote extras** — files that exist on the server but no longer exist locally.

### Sync Folder to Remote

Right-click one or more folders in the Explorer and choose **FileFerry: Sync Folder to Remote** to run the same mirror scoped to just those subtrees. Deletes (if enabled) are restricted to the folders you picked.

### Delete-extras safety

Deleting remote extras is **off by default** and asked per run. When you opt in:

1. A dry-run preview of the full plan is shown first.
2. A modal confirmation names the exact number of files that would be deleted.
3. Deletes are restricted to the mapped remote root (or the right-clicked folders).
4. Files matching `excludedPaths` are never pruned.
5. With **Back up before sync deletes** (a Project Settings toggle, on by default), each to-be-deleted file is downloaded to `.vscode/fileferry-backups/` first.

`.git` and `node_modules` are always skipped in both directions. Sync transfers appear in Upload History under the **Sync** source. Symlinks are neither synced nor pruned.

---

## Deploy Hooks and Secrets

Each server can define **pre-deploy** and **post-deploy** hook commands (Deployment Settings → **Hooks** tab) — build assets before upload, reload a service or run migrations after.

### How hooks run

- **Local** hooks run in your shell at the workspace root; **remote** hooks run over the deploy's own SSH connection (SFTP only — on FTP a remote hook is skipped with a warning).
- Hooks fire **only for deliberate deploys** (Upload / Upload All Changed / Only-If-Newer / To Servers / From Commits, and the Sync commands). Upload-on-save, the watcher, and every Remote Files panel operation never run them.
- Order: local pre-hooks → connect → remote pre-hooks → transfer → post-hooks. A long local build therefore never holds an SSH session idle.
- A failed **pre**-hook aborts the deploy before anything is transferred. A failed **post**-hook is reported but never rolls back files already uploaded. Each hook can opt into **continue on error** and a **timeout**.
- "Failed" means a non-zero exit code, a process that would not start, or a timeout — **never** stderr output on its own (many servers print banners/MOTD to stderr on success).
- Two safety gates: hooks are inert in an **untrusted workspace** (Workspace Trust), and the deploy confirmation names every command that will run.

### Keychain-backed secrets — `${secret:NAME}`

Type a secret once in the Hooks tab's **Secrets** section; the value goes into your OS keychain and the committed `fileferry.json` holds only the `${secret:NAME}` reference.

- Secrets are **per-project and machine-local** — a teammate re-enters them once; the Hooks tab flags referenced secrets that are missing on this machine.
- Resolution happens only at the moment a hook runs: dialogs, logs, and dry run always show the unresolved token, and resolved values are masked as `••••` in the output channel.
- Local hooks receive the value as an **environment variable** (the token is rewritten to your shell's own syntax), so it never enters the command string. Remote hooks inline it at exec time — briefly visible in the server's process list, so prefer the server's own environment for remote secrets.
- **Pre-flight check**: a deploy aborts before any transfer when a hook that would run references a missing or malformed secret — a post-deploy migration can't be silently skipped after the files are already live.
- Pasted a raw secret into a command? The inline warning offers a one-click **Move to keychain** that stores it and rewrites the command to a reference.

---

## Browsing Remote Files

Click the **FileFerry icon** in the activity bar to open the sidebar. It has two panels:

### Remote File Browser

Browse your remote server's filesystem. Click directories to expand them, click files to open them in the editor (editable — see [Managing Remote Files](#managing-remote-files)).

Features:

- File type icons match your VS Code icon theme
- Persistent connection with automatic idle timeout
- **Multi-select** — Ctrl/Shift-click several rows; Delete, Download, Copy Path, Duplicate, Move, and Change Permissions all operate on the whole selection. A context-menu command only appears when it applies to *every* selected row (stock VS Code behaviour), so e.g. a mixed file+folder selection won't offer file-only commands
- Path indicator shows your current location
- Use `FileFerry: Go to Remote Path` to jump to a specific directory
- The terminal icon in the panel title opens a shell in the folder the panel is showing; right-click any folder for **Open SSH Terminal Here** — see [Open SSH Terminal](#open-ssh-terminal)
- Use `FileFerry: Disconnect Remote Browser` to close the connection — the panel shows a **Disconnected** row and stays offline until you click it (or navigate/refresh explicitly); internal refreshes never reconnect behind your back. The command also drains pooled jump-host connections: idle hops close immediately, hops still under a live session (a running deploy, an open SSH terminal) close when that session ends

### Host key verification

Every SFTP connection — deploys, **Test Connection**, the Remote File Browser, diffs, backups — verifies the server's SSH host key the way OpenSSH does — *trust on first use*:

- **First connection to a host** — a modal shows the key's SHA-256 fingerprint (`The authenticity of host 'example.com:22' can't be established…`). Compare it with the fingerprint your hosting provider published (or run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server) and click **Trust** to save it. Closing the dialog rejects the connection.
- **Every later connection** — the presented key is compared with the saved one; a match connects silently, no prompt.
- **`WARNING: HOST KEY FOR … HAS CHANGED!`** — the server presented a *different* key than the one you trusted. Either the server was legitimately reinstalled / its keys rotated, or something between you and the server is impersonating it (a man-in-the-middle). If you didn't expect a change, click **Cancel** — the connection is refused and nothing is sent. **Trust Anyway** replaces the saved key.

Trusted keys live in `known_hosts.json` in the extension's global storage (`~/.config/Code/User/globalStorage/esidevlabs.fileferry/` on Linux, `~/Library/Application Support/Code/User/globalStorage/esidevlabs.fileferry/` on macOS, `%APPDATA%\Code\User\globalStorage\esidevlabs.fileferry\` on Windows). Delete an entry there to re-prompt for that host. Keys are matched on the key material alone, so entries saved by older versions keep working.

**Background connections never prompt.** Upload on save, the file watcher, the Remote Files panel rendering itself when it becomes visible, and `files.autoSave`-triggered remote-edit saves connect without any UI: the presented key is checked against the saved ones only. A trusted host connects silently; an unknown or changed key makes the connection fail fast instead of raising the modal — the upload paths show a non-modal *host not yet trusted or verification required* warning with a **Test Connection** button, and the Remote Files panel shows a **Host not verified — click to connect** row (clicking it is a normal, prompting connection). Trust the host once and background connections proceed silently from then on.

FTP/FTPS servers have no SSH host key — they use TLS certificates instead.

The first deploy to a host you have never trusted therefore shows the prompt too — and, while it is open, nothing is uploaded. If no prompt has opened within 20 seconds of starting a connection (the server is unreachable or silent), the connection fails with *Timed out waiting for the SSH handshake*.

> **Note (0.14.1 security fix):** in versions up to 0.14.0 the prompt was shown but did **not** block the connection — an unknown or changed host key was accepted before you answered. If you rely on host-key verification, update. In 0.14.1 only the Remote File Browser verified; every SFTP connection does now.

### Servers Panel

See all configured servers at a glance. The active server shows a filled circle indicator.

- Click a server to switch to it
- Right-click for options: **Edit Server**, **Test Connection**, **Open SSH Terminal** (a shell on that server, in its root path — see below)
- Hover a server to see its connection route — `Route: local → jump@bastion:2222 → deploy@target:22` for a jump-host chain, with a hop whose credential was deleted shown as `(missing jump host)`

---

## Open SSH Terminal

Open a shell on an SFTP server without leaving VS Code — and without an `ssh` binary. The terminal uses the same credential (keychain password, key, agent, or keyboard-interactive), the same host-key verification, the same `~/.ssh/config` resolution, and the same jump-host chain as your deploys. A server that is only reachable through a bastion with MFA is therefore one click away, and because bastion logins are pooled, a bastion that a deploy or the Remote Files panel already opened is reused without asking again.

Three ways in, each deciding where the shell starts:

- **`FileFerry: Open SSH Terminal`** (Command Palette) — the active server, in its root path.
- **Servers panel → right-click → Open SSH Terminal** — that server, in its root path (it does not have to be the active one).
- **Remote Files panel** — the terminal icon in the panel title opens a shell in the folder the panel is currently showing; right-click any folder → **Open SSH Terminal Here** for that folder.

The tab is named `FileFerry: <server> — <path>` and opens immediately with `Connecting to <server> via <route>…`; any password, one-time-code, or host-key prompt appears as usual while the tab waits. Dismissing a prompt cancels the connection — the tab says `Connection cancelled` and closes with exit code 1, as does any other connection failure (the message names the cause, including which jump host failed).

What to expect:

- **A login shell in the right directory.** The session changes into the directory and then `exec`s your login shell (`$SHELL`, falling back to `/bin/sh`), so your profile loads as it would over `ssh`. If the directory does not exist or is not readable, the `cd` fails silently and the shell opens in your home directory instead.
- **No MOTD, no `~/.ssh/rc`.** FileFerry opens an *exec* session rather than a plain interactive shell session — that is what keeps the start-up race-free — and OpenSSH prints the message of the day and runs `~/.ssh/rc` only for shell sessions. Everything your shell's own start-up files do still happens.
- **POSIX shells only.** The start-up command is POSIX `sh` syntax; a server whose login shell is not POSIX-compatible (Windows OpenSSH with `cmd`/PowerShell, for instance) will not start correctly.
- **Resizing works**, and the shell's exit status becomes the terminal's exit code — typing `exit` closes the tab; closing the tab ends the session.
- **`FileFerry: Disconnect Remote Browser` leaves the terminal alone.** A jump host under an open terminal stays connected until the last terminal (and any deploy) using it finishes; then it closes. If the hop drops for another reason — the bastion restarted, or you edited the hop's credential — the terminal closes with `connection to <hop> lost`.
- **Agent forwarding is not requested**, even if your `~/.ssh/config` says `ForwardAgent yes` — the terminal authenticates with the server's credential only.
- Each invocation opens its own terminal; several can be open at once, on the same or different servers. FTP/FTPS servers cannot open a terminal — the command refuses with a message.

---

## Managing Remote Files

The Remote Files panel is a full file manager. Every operation below shares the same ground rules:

- **Dry Run applies** — with dry run on, the operation logs its plan to the output channel (`$(beaker)` in the status bar) and touches nothing.
- **Deploy hooks never fire** — panel operations are file-manager actions, not deploys.
- **Collisions are never merged**: writing onto an existing *file* asks **Overwrite / Cancel**; onto an existing *folder* the operation aborts with an error. In multi-select mode nothing ever prompts and nothing is overwritten — colliding items are auto-renamed or skipped and reported.
- Only operations that move bytes appear in Upload History (see [Upload History](#upload-history)); rename, move, and permission changes log nothing.

### Edit in Place

Click a file to open it in an editor wired to the server it came from: edit, save, and the file uploads straight back — no download-edit-upload round-trip.

Every save is guarded: if the file **changed on the server** since you opened it, a modal offers **Overwrite** or **Show Diff** (server version side by side with yours) before anything is lost; a file merely *touched* (same content, newer timestamp) uploads without nagging. Saves honour Dry Run and Backup Before Overwrite and log to history under **Remote Edit**. If you switch the project's default server while editing, the save is blocked with a warning instead of landing on the wrong server.

If you **rename or move** an open file (or a folder containing it) from the panel, the edit session follows: the next save uploads to the new path. The editor tab keeps its original name — cosmetic only.

FTP note: FTP reports timestamps at second granularity, so conflict detection there is slightly coarser.

### New File / New Folder

Right-click a folder for **New File…** / **New Folder…**, or use the panel menu's **New File/Folder in Current Path…** to create at the path the panel currently shows. A new file is created empty and opens immediately in the edit-in-place flow — create → type → save lands on the server in one motion (logged under **Remote Create**). Names are validated as you type: no slashes or backslashes, not `.` or `..`.

### Rename

**Rename…** on any file or folder. The input is prefilled with the current name — for files only the stem is selected, so typing replaces the name and keeps the extension. Renaming to the unchanged name is a silent no-op.

### Duplicate

**Duplicate…** copies a file or a whole folder next to itself.

- A single file prefills `<stem> copy<ext>` (`index.php` → `index copy.php`); a folder prefills `<name> copy`.
- A multi-selection never prompts: copies are auto-named `copy`, `copy 2` … `copy 9`, then skipped and reported when every name is taken.
- **Folder duplicates confirm with real numbers**: the tree is scanned first and the confirmation shows the exact file count and size — e.g. *"Duplicate 'assets' → 'assets copy' — 214 files, 132 MB (3 symlinks skipped)?"*. Empty subfolders are recreated; symlinks are never copied but are counted and named.
- A scan error **aborts before anything is written** — you never get a silently partial copy. Cancelling mid-copy stops at the next file and reports what was copied and what remains; nothing is rolled back.
- Copies move bytes, so each copied file logs to history under **Remote Duplicate**.

### Move

**Move to Folder…** relocates files and folders. A QuickPick browser picks the destination: navigate with the `$(folder)` rows and `..`, confirm with **Select this folder**.

- Moving a folder into itself (or its own subtree) is refused before anything is touched; an item already in the chosen folder is skipped with a note.
- A selected folder carries its selected contents with it (nested selections are deduplicated).
- Open edit sessions on moved files follow to the new path. Moves log no history (no bytes move).

### Change Permissions

**Change Permissions…** prompts for an octal mode (`644`, `755`, `2775`) — prefilled with the file's **current mode** when the server reports one. One prompt applies to every selected item (not prefilled for multi-selections). Deliberately **non-recursive** on folders: a folder's mode changes, its contents don't. To chmod a folder *and* specific children, select them together.

FTP honesty: on servers that reject `SITE CHMOD`, the panel reports the failure — it never fakes success.

### Upload Here

**Upload Files Here…** and **Upload Folder Here…** (context menu on any remote folder, plus **…to Current Path** variants in the panel menu) put local files at exactly that remote path.

- **This deliberately bypasses your path mappings and deploy settings** — it is "put these bytes there", not a deploy — and the single up-front confirmation says so, together with the exact file count and a note that same-named remote files will be overwritten.
- A folder upload recreates the subfolder skeleton and walks **everything** — there is no skip-list, so a folder containing `node_modules` uploads it too; the count in the confirmation makes that visible before anything transfers.
- Uploads are cancellable mid-run; the remainder is reported. Each uploaded file logs to history under **Remote Upload**.

### Remote-window pickers (WSL / SSH / containers)

In a remote VS Code window the native OS file dialog can't browse the window's filesystem, so VS Code falls back to a limited "simple dialog". FileFerry replaces it where it falls short: **Upload Folder Here…** uses a QuickPick browser with an explicit **Select this folder** row, and **Upload Files Here…** is a two-step picker — *step 1 of 2* navigates to a folder (**Choose files from this folder**), *step 2 of 2* multi-selects its files with checkboxes (Space toggles, Enter confirms). Desktop windows keep the native dialogs.

---

## Comparing Files

### Local vs Remote (from Source Control or Editor)

Select a file and press `Alt+P` or right-click and choose **FileFerry: Compare with Remote**. This opens VS Code's diff editor showing your local version on the left and the server version on the right.

### Remote vs Local (from Remote File Browser)

Right-click a file in the Remote File Browser and choose **Compare with Local**. Same diff view, initiated from the remote side.

### When there's nothing to see

Both compare commands classify the files before opening a diff: **identical** files report "is identical" and skip the diff entirely, and files that differ **only in line endings** (CRLF vs LF, or a trailing newline) say so explicitly — noting that a deploy would still overwrite them — instead of opening an empty-looking diff.

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

With a multi-selection, one confirmation names the exact count ("Delete 3 items from the server?"), deletes run sequentially, and failures are aggregated into a single message. A selection containing both a folder and files inside it is deduplicated first — the folder delete covers its children, and the count stays honest.

---

## Upload History

FileFerry automatically logs every upload operation to a per-project history file. You can browse, filter, and clear the history from a dedicated panel.

### Viewing History

Open the Upload History panel from any of these places:

- **Command Palette** — `FileFerry: Upload History`
- **Status bar menu** — click the FileFerry status bar item, then choose **Upload History**
- **Post-upload notification** — click the **Show History** button that appears after each upload

The panel shows a table of all uploads with columns for timestamp, file, server, action (upload/delete), **source** (how the transfer was triggered), result (success/failed/cancelled), and error message.

The **Source** column distinguishes: **Manual**, **On Save**, **Multi-Server**, **Watch**, **Sync**, **Remote Edit** (edit-in-place saves), **Remote Create** (panel-created files), **Remote Duplicate**, and **Remote Upload** (upload-here). Only byte-moving operations are logged — renames, moves, permission changes, and deletes from the panel don't appear.

### Filtering

Use the controls at the top of the panel to narrow down the history:

- **Server dropdown** — show only entries for a specific server
- **Result dropdown** — filter by success, failed, or cancelled
- **Source dropdown** — filter by any of the trigger sources above
- **File search** — free-text search across file paths

Filtering runs in the extension, not in the webview.

### Clearing History

Click **Clear History** to remove all entries. A confirmation prompt appears first. This cannot be undone.

### Configuration

History logging is always on by default. To adjust or disable it, add `historyMaxEntries` to your `.vscode/fileferry.json`:

- Default: `10000` entries. When exceeded, the oldest entries are trimmed automatically.
- Set to `0` to disable history logging entirely.

History is stored in `.vscode/fileferry-history.jsonl` and is machine-local — it should not be committed to git.

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

```text
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
- **File date guard** — warn before overwriting a remote file newer than your local copy
- **Backup before overwrite** — download remote files before replacing them (with retention controls)
- **Watch & auto-upload** — the file-system watcher and its glob patterns (see [Uploading Files](#uploading-files))
- **Back up before sync deletes** — download files before Sync to Remote's delete-extras removes them (on by default)

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

### Excluded Paths Reference

Comma-separated glob patterns set in the Mappings tab. Files matching these patterns are silently skipped during upload. Use this for files that should never be deployed: `node_modules, *.log, .env`.

---

## Keyboard Shortcuts

| Key | Action | Context |
| --- | --- | --- |
| `Alt+U` | Upload selected files | Source Control, Explorer, or Editor |
| `Alt+U` | Upload the selected rows | FileFerry → Changed Files view |
| `Alt+P` | Compare with Remote | Source Control or Editor |
| `Shift+Alt+U` | Upload to multiple servers | Source Control, Explorer, or Editor |
| `Ctrl+Alt+U` | Upload all changed files | Source Control, Explorer, or Editor |

Customize via `Preferences -> Keyboard Shortcuts` and search for `fileferry`.

---

## Commands Reference

| Command | Description |
| --- | --- |
| `FileFerry: Upload` | Upload selected files (SCM, Explorer, or Editor) |
| `FileFerry: Upload to Servers...` | Upload selected files to multiple servers |
| `FileFerry: Upload All Changed Files` | Deploy everything git considers changed to the default server (no selection needed) |
| `FileFerry: Upload Changed Files (Only If Newer)` | Same, but skip files whose remote copy is the same age or newer |
| `FileFerry: Upload Files from Commit` | Pick recent commit(s) from a list; uploads the working-tree version of every file those commits touched |
| `FileFerry: Sync to Remote` | Mirror the whole mapped local tree to the server (opt-in delete-extras) |
| `FileFerry: Sync Folder to Remote` | The same mirror scoped to right-clicked Explorer folder(s) |
| `FileFerry: Compare with Remote` | Diff local file against the server version |
| `FileFerry: Deployment Settings` | Open server, mapping, and hooks configuration |
| `FileFerry: Project Settings` | Open project-level toggles |
| `FileFerry: Upload History` | View and filter upload history for this project |
| `FileFerry: Manage SSH Credentials` | Add, edit, or delete credentials |
| `FileFerry: Switch Server` | Change the default server for this project |
| `FileFerry: Go to Remote Path` | Navigate the Remote File Browser to a path |
| `FileFerry: Disconnect Remote Browser` | Suspend the remote browser connection until explicitly resumed; also drains idle pooled jump hosts (ones held by a deploy or an open SSH terminal close on last release) |
| `FileFerry: Open SSH Terminal` | Open a shell on the active server in its root path, through its jump hosts (SFTP only) |
| `FileFerry: Reset Upload Confirmations` | Re-enable upload prompts |
| `FileFerry: Test Connection` | Verify server credentials |
| `FileFerry: New File/Folder in Current Path…` | Create an entry at the path the panel currently shows |
| `FileFerry: Upload Files/Folder to Current Path…` | Upload local files or a folder to the path the panel currently shows |

Remote Files panel context menu (right-click a file or folder):

| Command | Description |
| --- | --- |
| `New File…` / `New Folder…` | Create an entry inside the clicked folder |
| `Upload Files Here…` / `Upload Folder Here…` | Put local files or a folder tree at the clicked folder (bypasses mappings) |
| `Rename…` | Rename the clicked file or folder |
| `Duplicate…` | Copy file(s) or folder(s) next to themselves (auto-named in multi-select) |
| `Move to Folder…` | Move the selection to a destination picked in a folder browser |
| `Change Permissions…` | Set an octal mode on the selection (prefilled with the current mode) |
| `Download to Workspace` | Download remote file(s) to the mapped local path |
| `Compare with Local` | Diff a remote file against the local version |
| `Copy Remote Path` | Copy the selected remote path(s) to clipboard |
| `Open SSH Terminal Here` | Open a shell in the clicked folder (also in the panel title, for the folder currently shown) |
| `Delete from Server` | Delete the selection (with confirmation) |

Servers panel context menu (right-click a server): `Edit Server`, `Test Connection`, `Open SSH Terminal` (a shell on that server, in its root path).

---

## Config File Reference

`.vscode/fileferry.json` holds your server definitions, path mappings, and project toggles. You normally don't edit it by hand — Deployment Settings and Project Settings write it for you — but it's safe to commit and useful to read during code review or troubleshooting.

For the full field-by-field reference (including the JSON Schema, defaults, and worked examples), see [CONFIG.md](./CONFIG.md).

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

### "WARNING: HOST KEY FOR … HAS CHANGED!"

The server's SSH host key differs from the one saved on first connection. See [Host key verification](#host-key-verification) — if you didn't expect the change (server reinstall, key rotation), click **Cancel** and check with whoever runs the server before trusting the new key.

### "Connection cancelled" / "Timed out waiting for the SSH handshake"

*Connection cancelled* means you dismissed a host-key or 2FA prompt — run the command again and answer it. *Timed out waiting for the SSH handshake (20 s) before any prompt opened* means the server never got as far as asking anything: check host, port, and firewall, then **Test Connection** from the Servers panel.

### "Host not yet trusted or verification required"

A background connection (upload on save, the file watcher, an autosave-triggered remote-edit save) needed a host-key or 2FA prompt it is not allowed to show. Click **Test Connection** in the warning — or run any manual deploy — and answer the prompts once; background uploads then work. The Remote Files panel shows the same situation as a **Host not verified — click to connect** row: click it to connect with the prompts.

### The SSH terminal opens in my home directory

The terminal changes into the requested directory before starting your shell; when that `cd` fails (the path does not exist on the server, or your user cannot enter it) the failure is silent and the login shell starts in `$HOME` instead. Check the server's root path in Deployment Settings, or the folder you right-clicked. Also expected: no message of the day and no `~/.ssh/rc` — the terminal is an exec session (see [Open SSH Terminal](#open-ssh-terminal)).

### Remote File Browser shows an error

Click the error item to retry the connection, or check your server configuration in **Deployment Settings**. If the server is unreachable, verify the host, port, and credentials.

### Upload on save not working

Make sure it's enabled in **Project Settings**. Files in your `.gitignore` are never auto-uploaded. Check that the file you're saving isn't excluded by your ignore patterns.

### "Unreadable directory (listing denied)" on FTP

Duplicating or browsing hit a directory your FTP user cannot read. Some FTP servers report such directories as *empty* rather than failing; FileFerry probes and refuses instead — otherwise a folder duplicate would silently produce a partial copy. Fix the directory's permissions on the server (or exclude it) and retry.

### A remote hook didn't run on FTP

Remote hooks need an SSH exec channel, which only SFTP provides. On FTP/FTPS servers the remote hook is skipped with a warning; local hooks run normally.
