// FileFerry Project Settings webview
// Runs inside the VSCode webview iframe — no Node.js, no VSCode API access.
// All data persistence goes through postMessage to the extension.

const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  config: null, // ProjectConfig
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

vscode.postMessage({ command: 'ready' });

// ─── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', ({ data: msg }) => {
  switch (msg.command) {
    case 'init':
      state.config = msg.config || { defaultServerId: '', servers: {} };
      render();
      break;

    case 'configUpdated':
      state.config = msg.config || { defaultServerId: '', servers: {} };
      render();
      break;
  }
});

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  if (!app || !state.config) return;

  const uploadOnSave = !!state.config.uploadOnSave;
  // fileDateGuard defaults to true when undefined
  const fileDateGuard = state.config.fileDateGuard !== false;
  const backupBeforeOverwrite = !!state.config.backupBeforeOverwrite;
  const backupRetentionDays = state.config.backupRetentionDays ?? 7;
  const backupMaxSizeMB = state.config.backupMaxSizeMB ?? 100;

  app.innerHTML = `
    <h2>Project Settings</h2>
    <p class="hint">These settings apply to all servers in this project.</p>

    <div class="setting-row">
      <label class="toggle-label">
        <input type="checkbox" id="chk-upload-on-save" ${uploadOnSave ? 'checked' : ''}>
        <span class="toggle-text">
          <strong>Upload on Save</strong>
          <span class="toggle-description">Automatically upload files when you save them.</span>
        </span>
      </label>
    </div>

    <div class="setting-row">
      <label class="toggle-label">
        <input type="checkbox" id="chk-file-date-guard" ${fileDateGuard ? 'checked' : ''}>
        <span class="toggle-text">
          <strong>File Date Guard</strong>
          <span class="toggle-description">Warn before overwriting files that are newer on the remote server.</span>
        </span>
      </label>
    </div>

    <div class="setting-row">
      <label class="toggle-label">
        <input type="checkbox" id="chk-backup-before-overwrite" ${backupBeforeOverwrite ? 'checked' : ''}>
        <span class="toggle-text">
          <strong>Backup Before Overwrite</strong>
          <span class="toggle-description">Download remote files to a local backup before uploading.</span>
        </span>
      </label>
      ${backupBeforeOverwrite ? `
      <div class="sub-settings">
        <div class="number-field">
          <label for="input-retention-days">Retention days</label>
          <input type="number" id="input-retention-days" min="1" value="${backupRetentionDays}">
        </div>
        <div class="number-field">
          <label for="input-max-size-mb">Max size (MB)</label>
          <input type="number" id="input-max-size-mb" min="1" value="${backupMaxSizeMB}">
        </div>
      </div>
      ` : ''}
    </div>
  `;

  document.getElementById('chk-upload-on-save')?.addEventListener('change', () => {
    vscode.postMessage({ command: 'toggleUploadOnSave' });
  });

  document.getElementById('chk-file-date-guard')?.addEventListener('change', () => {
    vscode.postMessage({ command: 'toggleFileDateGuard' });
  });

  document.getElementById('chk-backup-before-overwrite')?.addEventListener('change', () => {
    vscode.postMessage({ command: 'toggleBackupBeforeOverwrite' });
  });

  document.getElementById('input-retention-days')?.addEventListener('change', (e) => {
    const value = parseInt(e.target.value, 10);
    if (value > 0) {
      vscode.postMessage({ command: 'setBackupRetentionDays', value });
    }
  });

  document.getElementById('input-max-size-mb')?.addEventListener('change', (e) => {
    const value = parseInt(e.target.value, 10);
    if (value > 0) {
      vscode.postMessage({ command: 'setBackupMaxSizeMB', value });
    }
  });
}
