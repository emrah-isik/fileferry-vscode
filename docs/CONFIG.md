# `.vscode/fileferry.json` Reference

This is the per-project configuration file FileFerry writes when you save Deployment Settings or Project Settings. It contains server definitions, path mappings, and project-level toggles.

It does **not** contain credentials. Passwords, passphrases, and SSH key contents live in your OS keychain (macOS Keychain / Windows Credential Manager / Linux libsecret) and are referenced from `fileferry.json` only by UUID. The file is safe to commit to git.

You normally never edit this file by hand — Deployment Settings and Project Settings write it for you. This reference is for reading the file, troubleshooting, code review, and the rare case where you want to tweak something without opening the UI.

---

## Editor Support

VS Code automatically validates and autocompletes `.vscode/fileferry.json` against the bundled JSON Schema ([schema/fileferry-schema.json](../schema/fileferry-schema.json)). You get:

- IntelliSense for every field
- Inline errors for unknown fields, wrong types, or missing required values
- Hover documentation on each property

No extra configuration needed — the schema is registered via `contributes.jsonValidation` in the extension manifest.

---

## Top-Level Fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `defaultServerId` | `string` (UUID) | yes | — | UUID of the server used for `Alt+U` uploads, upload-on-save, and `Ctrl+Alt+U`. Must match the `id` of one of the entries in `servers`. |
| `servers` | `object` | yes | — | Server definitions, keyed by display name. See [Server Fields](#server-fields). |
| `uploadOnSave` | `boolean` | no | `false` | When `true`, files are uploaded to the default server every time they're saved. Respects `.gitignore`. |
| `dryRun` | `boolean` | no | `false` | When `true`, upload commands write a structured plan to the FileFerry output channel without opening any connections. |
| `fileDateGuard` | `boolean` | no | `true` | When `false`, skips the remote mtime check that warns before overwriting newer remote files. |
| `backupBeforeOverwrite` | `boolean` | no | `false` | When `true`, downloads each existing remote file to `.vscode/fileferry-backups/<timestamp>-<server>/` before uploading the replacement. |
| `syncBackupBeforeDelete` | `boolean` | no | `true` | When `true` (the default), **Sync to Remote** downloads each remote file to `.vscode/fileferry-backups/<timestamp>-<server>/` before its delete-extras step prunes it. Deletes are irreversible, so this is opt-out. |
| `backupRetentionDays` | `integer` ≥ 0 | no | `7` | Days to keep backup folders before automatic cleanup. |
| `backupMaxSizeMB` | `integer` ≥ 0 | no | `100` | Maximum total size of the backups folder in megabytes. Oldest backups are pruned first. |
| `historyMaxEntries` | `integer` ≥ 0 | no | `10000` | Cap on entries in `.vscode/fileferry-history.jsonl`. Set to `0` to disable history logging entirely. |
| `watch` | `object` | no | — | Auto-upload files matching glob patterns whenever they change on disk — including build outputs and other externally-generated files that never trigger an editor save. See [Watch](#watch). |

---

## Watch

Auto-uploads files matching `watch.patterns` whenever they change on disk, to the default
server. Unlike **upload-on-save** (which only fires for files you save in the editor and
skips git-ignored files), the watcher reacts to *any* filesystem change — so it covers files
written by build tools, compilers, and scripts — and **uploads watched files even when they
are git-ignored**, because the patterns you declare are an explicit allowlist (build outputs
like `dist/` are usually git-ignored, and uploading them is the whole point).

It still honors each server's `excludedPaths`, the `fileDateGuard` (skips and logs files the
remote already has newer), and `dryRun` (logs the plan, transfers nothing). Rapid bursts of
writes are debounced and uploaded as one batch. FileFerry never re-uploads its own writes
(`.fileferry-backups/`, the config files).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | yes | Turns the watcher on or off. |
| `patterns` | `string[]` | yes | Workspace-relative glob patterns to watch. May be empty (watcher does nothing). |

```jsonc
{
  "watch": {
    "enabled": true,
    "patterns": ["dist/**", "build/**/*.js", "public/build/**"]
  }
}
```

> Deletes are not synced — removing a local file does not delete it remotely. Watching
> covers file creation and changes only.

---

## Server Fields

Each entry in the `servers` object is keyed by its display name (the name you see in the status bar and Servers panel). The value object has these fields:

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | `string` (UUID) | yes | — | Internal identifier, stable across renames. References from `defaultServerId` and from upload history use this, not the display name. |
| `type` | `"sftp"` \| `"ftp"` \| `"ftps"` \| `"ftps-implicit"` | yes | — | Connection protocol. `ftps` is explicit TLS (AUTH TLS on port 21); `ftps-implicit` is implicit TLS (port 990). |
| `credentialId` | `string` (UUID) | yes | — | UUID of the credential entry in the OS keychain. Created via `FileFerry: Manage SSH Credentials`. |
| `credentialName` | `string` | yes | — | Human-readable credential name. Used as a documentation aid and as a fallback label when the UUID cannot be resolved (e.g. teammate hasn't set up credentials yet). |
| `rootPath` | `string` | yes | — | Absolute path on the remote server. All path mappings resolve relative to this. Example: `/var/www`. |
| `mappings` | `array` | yes | — | Local-to-remote path mappings. See [Path Mappings](#path-mappings). |
| `excludedPaths` | `string[]` | yes | — | Glob patterns for files and folders to never upload. Example: `["node_modules", "*.log", ".env"]`. May be an empty array. |
| `filePermissions` | `integer` 0–511 | no | (server default) | Decimal representation of an octal permission mode applied to uploaded files. `0644` is `420`, `0600` is `384`. SFTP only; FTP makes a best-effort `SITE CHMOD`. |
| `directoryPermissions` | `integer` 0–511 | no | (server default) | Same as above, for created directories. `0755` is `493`, `0700` is `448`. |
| `timeOffsetMs` | `integer` | no | `0` | Clock skew in milliseconds (`remote − local`). Detected automatically during Test Connection; `FileDateGuard` subtracts this before comparing timestamps. |
| `hooks` | `object` | no | — | Commands run automatically before/after a deliberate deploy to this server. See [Deploy Hooks](#deploy-hooks). |

### Path Mappings

Each entry in the `mappings` array translates a local path to a remote path:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `localPath` | `string` | yes | Path relative to the workspace root. Use `/` for the whole project. Example: `/public`. |
| `remotePath` | `string` | yes | Path relative to the server's `rootPath`. Example: `public_html`. |

When multiple mappings could match a file, the **most specific (longest) `localPath`** wins. If `mappings` is empty, files map directly to `rootPath` preserving their workspace-relative path.

### Permission Mode Cheat Sheet

`filePermissions` and `directoryPermissions` are stored as decimal integers because JSON has no native octal literal. Common values:

| Octal | Decimal | Typical use |
| --- | --- | --- |
| `0600` | `384` | Private files (e.g. `.env`) |
| `0644` | `420` | Standard read-only files |
| `0664` | `436` | Group-writable files |
| `0700` | `448` | Private directories |
| `0750` | `488` | Group-readable directories |
| `0755` | `493` | Standard directories |
| `0775` | `509` | Group-writable directories |

### Deploy Hooks

`hooks` runs a command automatically before and/or after a deploy to this server — to build artifacts before upload, or reload a service / run migrations / fix ownership after. Hooks run only for **deliberate** deploys (Upload Selected/All Changed/To Servers, Upload From Commits, Only-If-Newer, and the Sync commands). **Upload-on-save and the file watcher never run hooks.**

```json
"hooks": {
  "preDeploy": [
    { "command": "npm run build", "location": "local" }
  ],
  "postDeploy": [
    { "command": "sudo systemctl reload nginx", "location": "remote" },
    { "command": "php artisan migrate --force", "location": "remote", "continueOnError": true }
  ]
}
```

Each hook:

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `command` | `string` | yes | — | The shell command. Local commands run in your default shell at the workspace root; remote commands run on the server. |
| `location` | `"local"` \| `"remote"` | yes | — | Where it runs. `remote` requires **SFTP** — on FTP/FTPS a remote hook is skipped with a warning (FTP can't run shell commands). |
| `continueOnError` | `boolean` | no | `false` | When `true`, a failure is logged but doesn't abort the deploy or stop later hooks. |
| `timeoutMs` | `integer` | no | — | Per-hook timeout. On timeout the command is killed (local) / its channel destroyed (remote) and the hook fails. |

**Ordering and failure.** Local pre-hooks run **before** the connection opens (a build can take minutes — no point holding SSH idle); remote pre-hooks run on the just-opened session. A failed **pre**-hook **aborts the deploy** (nothing is uploaded) unless `continueOnError` is set. A failed **post**-hook is reported but does **not** roll back the files already uploaded. "Failed" means a non-zero/`null` exit code, a process that wouldn't start, or a timeout — **never** stderr output on its own: many servers write banners/MOTD/locale warnings to stderr on a successful (exit 0) command, so that's logged for visibility, not treated as a failure.

**Security — hooks run shell commands.** Two guards apply:

1. **Workspace Trust.** FileFerry **requires a trusted workspace** — the extension is disabled entirely in VS Code's Restricted Mode, so hooks (and every other FileFerry action) are inert until you explicitly trust the folder. Opening someone else's repo is untrusted by default. (Deploying already reads the server, paths, and credential from the repo's `fileferry.json` and connects with your stored credentials, so deploying is itself trust-requiring — not just hooks.)
2. **Visible in the deploy confirmation.** The pre-deploy confirmation names the hook commands that will run — the full list is written to the FileFerry output channel and the confirmation points you to it — so nothing runs that you didn't see.

**No secrets in `fileferry.json`** — it's committed to git. Keep secrets out of the command string:

- **Environment variables (recommended).** Local hooks inherit your shell environment, so write `mysql -p"$DB_PASS" …` and keep `DB_PASS` in your environment or a git-ignored `.env`. The committed file holds only the literal `$DB_PASS`; it's expanded at run time.
- **`fileferry.local.json` (git-ignored escape hatch).** For a command you don't want committed at all, put the server's `hooks` in `.vscode/fileferry.local.json` instead. FileFerry reads it and **merges its hooks over** the committed config for that server, and adds the file to `.gitignore` on first write so it's never committed. The committed `fileferry.json` stays clean for everyone else.
- **Remote-hook caveat.** SSH usually rejects client-set environment variables (`AcceptEnv` is restrictive), so `$VAR` expansion is unreliable for **remote** hooks. Prefer keeping remote secrets in the *server's* own environment / a remote `.env` so FileFerry never handles the value.

FileFerry masks values it resolved itself in the output channel, but it can't catch a secret a command prints on its own — so the rules above matter.

**Build artifacts won't deploy via a git-changed upload.** A local `npm run build` in `preDeploy` does **not** add files to an *Upload Changed Files* deploy. The changed set is resolved before the hook runs, and it's read from git state — which is `.gitignore`-respecting, so build output in `dist/` (usually git-ignored) never appears in it regardless. To deploy generated files, use **Sync to Remote** (walks the filesystem tree at transfer time) or the **Watch** feature (an explicit glob allowlist that uploads git-ignored files).

**Duplication across servers.** Hooks are per-server, so a local build identical across dev/staging/prod must be repeated in each server's config (and kept in sync). Project-level shared hooks are a planned future addition.

---

## Examples

### Minimal — Single SFTP Server

```json
{
  "defaultServerId": "8e3f2a1c-9b4d-4e7f-a2c1-d5e6f7a8b9c0",
  "servers": {
    "Production": {
      "id": "8e3f2a1c-9b4d-4e7f-a2c1-d5e6f7a8b9c0",
      "type": "sftp",
      "credentialId": "12abf3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      "credentialName": "deploy@prod",
      "rootPath": "/var/www",
      "mappings": [
        { "localPath": "/", "remotePath": "html" }
      ],
      "excludedPaths": ["node_modules", ".env", "*.log"]
    }
  }
}
```

A change to `src/app.php` uploads to `/var/www/html/src/app.php`.

### Multi-Server with Project Toggles

```json
{
  "defaultServerId": "8e3f2a1c-9b4d-4e7f-a2c1-d5e6f7a8b9c0",
  "uploadOnSave": true,
  "fileDateGuard": true,
  "backupBeforeOverwrite": true,
  "backupRetentionDays": 14,
  "servers": {
    "Staging": {
      "id": "8e3f2a1c-9b4d-4e7f-a2c1-d5e6f7a8b9c0",
      "type": "sftp",
      "credentialId": "12abf3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      "credentialName": "deploy@staging",
      "rootPath": "/var/www/staging",
      "mappings": [
        { "localPath": "/", "remotePath": "" },
        { "localPath": "/public", "remotePath": "public_html" }
      ],
      "excludedPaths": ["node_modules", ".env", ".git", "vendor"]
    },
    "Production": {
      "id": "f0e1d2c3-b4a5-4968-87a6-5b4c3d2e1f00",
      "type": "sftp",
      "credentialId": "98765432-1234-4321-8765-abcdef012345",
      "credentialName": "deploy@prod",
      "rootPath": "/var/www/prod",
      "mappings": [
        { "localPath": "/", "remotePath": "" },
        { "localPath": "/public", "remotePath": "public_html" }
      ],
      "excludedPaths": ["node_modules", ".env", ".git", "vendor"],
      "filePermissions": 420,
      "directoryPermissions": 493
    }
  }
}
```

`Alt+U` uploads to Staging (the default). `Shift+Alt+U` opens a multi-server picker so you can push to both.

### FTPS with Permission Overrides

```json
{
  "defaultServerId": "aaaa1111-bbbb-2222-cccc-3333dddd4444",
  "dryRun": false,
  "historyMaxEntries": 5000,
  "servers": {
    "Shared Hosting": {
      "id": "aaaa1111-bbbb-2222-cccc-3333dddd4444",
      "type": "ftps",
      "credentialId": "ccc99988-7766-4455-3322-1100eeffaabb",
      "credentialName": "ftp-user",
      "rootPath": "/home/ftp-user",
      "mappings": [
        { "localPath": "/", "remotePath": "public_html" }
      ],
      "excludedPaths": ["*.bak", ".DS_Store"],
      "filePermissions": 420,
      "directoryPermissions": 493
    }
  }
}
```

---

## Sibling Files

These files live alongside `fileferry.json` in `.vscode/`:

| File | Purpose | Commit? |
| --- | --- | --- |
| `fileferry.json` | This file — config and server definitions | yes |
| `fileferry.local.json` | Per-server `hooks` overrides you don't want committed (e.g. secret-bearing commands). Merged over `fileferry.json` at deploy time. | no — auto-`.gitignore`d on first write |
| `fileferry-history.jsonl` | Per-project upload log (one JSON entry per line) | no — auto-`.gitignore`d on first write |
| `fileferry-backups/` | Pre-overwrite backups when `backupBeforeOverwrite` is on | no — auto-`.gitignore`d on first write |

**FileFerry adds each of these machine-local files to your workspace `.gitignore` the first
time it writes them** (creating `.gitignore` if needed — it works even before `git init`). You
shouldn't need to add them by hand, but for reference the entries are:

```gitignore
.vscode/fileferry.local.json
.vscode/fileferry-history.jsonl
.vscode/fileferry-backups/
```

> Note: `.gitignore` can't untrack a file that's **already committed**. If one of these got into
> git before FileFerry ignored it, run `git rm --cached <path>` once. FileFerry also **never
> deploys** any of its own files (including the committed `fileferry.json`), so they won't be
> published to your server regardless.

---

## Migration Notes

If you're coming from FileFerry v0.4 or earlier, the old global `servers.json` and binding-only `.vscode/fileferry.json` are merged into the current project-config format automatically on activation. The old `servers.json` is left in place but no longer read.
