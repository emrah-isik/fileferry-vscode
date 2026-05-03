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
| `backupRetentionDays` | `integer` ≥ 0 | no | `7` | Days to keep backup folders before automatic cleanup. |
| `backupMaxSizeMB` | `integer` ≥ 0 | no | `100` | Maximum total size of the backups folder in megabytes. Oldest backups are pruned first. |
| `historyMaxEntries` | `integer` ≥ 0 | no | `10000` | Cap on entries in `.vscode/fileferry-history.jsonl`. Set to `0` to disable history logging entirely. |

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
| `fileferry-history.jsonl` | Per-project upload log (one JSON entry per line) | no — machine-local |
| `fileferry-backups/` | Pre-overwrite backups when `backupBeforeOverwrite` is on | no — machine-local |

Add the latter two to `.gitignore`:

```gitignore
.vscode/fileferry-history.jsonl
.vscode/fileferry-backups/
```

---

## Migration Notes

If you're coming from FileFerry v0.4 or earlier, the old global `servers.json` and binding-only `.vscode/fileferry.json` are merged into the current project-config format automatically on activation. The old `servers.json` is left in place but no longer read.
