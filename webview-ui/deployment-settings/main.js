// FileFerry Deployment Settings webview
// Runs inside the VSCode webview iframe — no Node.js, no VSCode API access.
// All data persistence goes through postMessage to the extension.

const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  config: null,           // ProjectConfig: { defaultServerId, uploadOnSave?, servers: { [name]: ProjectServer } }
  credentials: [],
  selectedServerName: null,
  activeTab: 'connection',
  testStatus: null,       // { success, message } | null
  editingNew: false,      // true when creating a new (unsaved) server
  secretNames: [],        // hook secret NAMEs stored in the OS keychain (values never reach the webview)
  secretsSectionOpen: null, // user's explicit open/collapse choice; null = auto (open when a secret is missing)
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Tell the extension we are ready to receive the init message
vscode.postMessage({ command: 'ready' });

// ─── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', ({ data: msg }) => {
  switch (msg.command) {
    case 'init':
      state.config = msg.config || { defaultServerId: '', servers: {} };
      state.credentials = msg.credentials || [];
      state.secretNames = msg.secretNames || [];
      if (!state.selectedServerName) {
        const names = Object.keys(state.config.servers);
        if (names.length > 0) state.selectedServerName = names[0];
      }
      render();
      break;

    case 'configUpdated':
      state.config = msg.config || { defaultServerId: '', servers: {} };
      // If selected server was deleted, select first remaining
      if (state.selectedServerName && !state.config.servers[state.selectedServerName]) {
        const names = Object.keys(state.config.servers);
        state.selectedServerName = names[0] || null;
        state.editingNew = false;
      }
      render();
      break;

    case 'credentialsUpdated':
      state.credentials = msg.credentials || [];
      renderConnectionTab(getSelectedServer());
      break;

    case 'testResult': {
      const composedMessage = msg.message ?? (msg.success && msg.timeOffsetMs !== undefined
        ? `Time offset: ${formatTimeOffset(msg.timeOffsetMs)}`
        : '');
      state.testStatus = { success: msg.success, message: composedMessage, warning: msg.warning };
      if (msg.success && msg.timeOffsetMs !== undefined) {
        const stateServer = state.config?.servers?.[state.selectedServerName];
        if (stateServer) {
          stateServer.timeOffsetMs = msg.timeOffsetMs;
        }
        renderTimeOffset(msg.timeOffsetMs);
      }
      renderTestResult();
      break;
    }

    case 'directorySelected':
      const rootInput = document.getElementById('f-root-path');
      if (rootInput) rootInput.value = msg.path;
      const rootErrEl = document.getElementById('err-root-path');
      if (rootErrEl) rootErrEl.textContent = '';
      setBrowseLoading(false);
      break;

    case 'browseDone':
      setBrowseLoading(false);
      break;

    case 'browseError':
      setBrowseLoading(false);
      const browseErrEl = document.getElementById('test-connection-result');
      if (browseErrEl) {
        browseErrEl.className = 'error';
        browseErrEl.textContent = `\u2717 ${msg.message}`;
      }
      break;

    case 'validationError':
      showValidationErrors(msg.errors);
      break;

    case 'hookSecretWarning':
      showHookSecretWarnings(msg.commands || []);
      break;

    // Secrets changed in the keychain — refresh the secrets area and the
    // per-row indicators WITHOUT re-rendering the whole tab (that would wipe
    // unsaved hook command edits).
    case 'secretsUpdated':
      state.secretNames = msg.secretNames || [];
      renderSecretsSection();
      refreshHookSecretIndicators();
      break;

    case 'secretError': {
      const secretsErrorEl = document.getElementById('secrets-error');
      if (secretsErrorEl) secretsErrorEl.textContent = msg.message || 'Secret operation failed.';
      break;
    }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isFtpType(type) {
  return type === 'ftp' || type === 'ftps' || type === 'ftps-implicit';
}

function buildCredentialOptions(serverType, selectedCredentialId) {
  const isFtp = isFtpType(serverType);
  const filtered = isFtp
    ? state.credentials.filter(c => c.authMethod === 'password')
    : state.credentials;
  return `
    <option value="">\u2014 Select credential \u2014</option>
    ${filtered.map(c => `
      <option value="${escapeHtml(c.id)}" ${selectedCredentialId === c.id ? 'selected' : ''}>
        ${escapeHtml(c.name)} (${escapeHtml(c.username)}@${escapeHtml(c.host)})
      </option>
    `).join('')}
  `;
}

function updateProtocolHint(type) {
  const el = document.getElementById('protocol-hint');
  if (!el) return;
  if (isFtpType(type)) {
    el.textContent = 'FTP/FTPS only supports password authentication. Default port: ' + (type === 'ftps-implicit' ? '990' : '21');
  } else {
    el.textContent = '';
  }
}

function setBrowseLoading(loading) {
  const btn = document.getElementById('btn-browse-root');
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle('btn-loading', loading);
  btn.textContent = loading ? 'Browsing\u2026' : 'Browse\u2026';
}

function getServerEntries() {
  if (!state.config) return [];
  return Object.entries(state.config.servers);
}

function getSelectedServer() {
  if (state.editingNew) return { _name: '', id: '', type: 'sftp', credentialId: '', credentialName: '', rootPath: '', mappings: [], excludedPaths: [] };
  if (!state.selectedServerName || !state.config) return null;
  const server = state.config.servers[state.selectedServerName];
  if (!server) return null;
  return { _name: state.selectedServerName, ...server };
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  renderServerList();
  renderDetailPanel();
}

function renderServerList() {
  const el = document.getElementById('server-list-panel');
  if (!el) return;

  const entries = getServerEntries();
  const defaultId = state.config?.defaultServerId || '';

  el.innerHTML = `
    <div class="panel-header">
      <span>Servers</span>
      <button id="add-server-btn" title="Add server">+</button>
    </div>
    <ul class="server-list">
      ${entries.map(([name, server]) => `
        <li class="server-item ${name === state.selectedServerName && !state.editingNew ? 'selected' : ''}"
            data-name="${escapeHtml(name)}">
          <span class="server-name">${escapeHtml(name)}</span>
          ${defaultId === server.id ? '<span class="badge">default</span>' : ''}
          <button class="btn-clone-server" data-id="${escapeHtml(server.id)}" title="Clone server" tabindex="-1">\u2398</button>
        </li>
      `).join('')}
      ${state.editingNew ? '<li class="server-item selected"><span class="server-name"><em>New Server</em></span></li>' : ''}
    </ul>
  `;

  document.getElementById('add-server-btn')?.addEventListener('click', () => {
    state.editingNew = true;
    state.selectedServerName = null;
    state.testStatus = null;
    state.activeTab = 'connection';
    render();
  });

  document.querySelectorAll('.server-item[data-name]').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedServerName = el.dataset.name;
      state.editingNew = false;
      state.testStatus = null;
      render();
    });
  });

  document.querySelectorAll('.btn-clone-server').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ command: 'cloneServer', id: btn.dataset.id });
    });
  });
}

function renderDetailPanel() {
  const server = getSelectedServer();

  if (!server && !state.editingNew) {
    document.getElementById('connection-tab').innerHTML = '';
    document.getElementById('mappings-tab').innerHTML = '';
    const detail = document.getElementById('server-detail-panel');
    if (detail) detail.innerHTML = '<div class="empty-state">Select or add a server to get started</div>';
    return;
  }

  // Ensure tabs container is restored (may have been replaced by empty-state)
  const detail = document.getElementById('server-detail-panel');
  if (!detail.querySelector('.tabs')) {
    detail.innerHTML = `
      <div class="tabs">
        <button class="tab-btn active" data-tab="connection">Connection</button>
        <button class="tab-btn" data-tab="mappings">Mappings</button>
        <button class="tab-btn" data-tab="hooks">Hooks</button>
      </div>
      <div id="connection-tab" class="tab-content active"></div>
      <div id="mappings-tab" class="tab-content"></div>
      <div id="hooks-tab" class="tab-content"></div>
    `;
  }

  // Wire tab buttons
  detail.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      detail.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === state.activeTab));
      detail.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `${state.activeTab}-tab`));
    });
  });

  detail.querySelectorAll('.tab-content').forEach(t => {
    t.classList.toggle('active', t.id === `${state.activeTab}-tab`);
  });

  renderConnectionTab(server);
  renderMappingsTab(server);
  renderHooksTab(server);
}

function renderConnectionTab(server) {
  const el = document.getElementById('connection-tab');
  if (!el) return;

  const isDefault = state.config?.defaultServerId === server.id;
  const isNew = !server.id;

  el.innerHTML = `
    <div class="form-group">
      <label for="f-name">Name</label>
      <input id="f-name" type="text" value="${escapeHtml(server._name)}" placeholder="e.g. Production">
      <span class="field-error" id="err-name"></span>
    </div>

    <div class="form-group">
      <label for="f-type">Protocol</label>
      <select id="f-type">
        <option value="sftp" ${server.type === 'sftp' ? 'selected' : ''}>SFTP</option>
        <option value="ftp" ${server.type === 'ftp' ? 'selected' : ''}>FTP</option>
        <option value="ftps" ${server.type === 'ftps' ? 'selected' : ''}>FTPS (Explicit TLS)</option>
        <option value="ftps-implicit" ${server.type === 'ftps-implicit' ? 'selected' : ''}>FTPS (Implicit TLS)</option>
      </select>
      <span class="field-hint" id="protocol-hint"></span>
    </div>

    <div class="form-group">
      <label for="f-credential">
        Credential
        <button id="btn-manage-creds" class="btn-inline-link" type="button">Manage\u2026</button>
      </label>
      <select id="f-credential">
        ${buildCredentialOptions(server.type, server.credentialId)}
      </select>
      <span class="field-error" id="err-credential"></span>
    </div>

    <div class="form-group">
      <label for="f-root-path">Root Path</label>
      <div class="input-row">
        <input id="f-root-path" type="text" value="${escapeHtml(server.rootPath)}" placeholder="/var/www">
        <button id="btn-browse-root" class="btn-secondary" type="button">Browse\u2026</button>
      </div>
      <span class="field-error" id="err-root-path"></span>
    </div>

    <div class="form-group">
      <label for="f-file-permissions">File Permissions</label>
      <input id="f-file-permissions" type="text" value="${server.filePermissions !== undefined ? server.filePermissions.toString(8).padStart(4, '0') : ''}" placeholder="e.g. 0644 (leave blank to keep server default)">
      <span class="field-hint">Octal mode set on uploaded files (e.g. 0644). FTP: best-effort only.</span>
    </div>

    <div class="form-group">
      <label for="f-dir-permissions">Directory Permissions</label>
      <input id="f-dir-permissions" type="text" value="${server.directoryPermissions !== undefined ? server.directoryPermissions.toString(8).padStart(4, '0') : ''}" placeholder="e.g. 0755 (leave blank to keep server default)">
      <span class="field-hint">Octal mode set on created directories (e.g. 0755). FTP: best-effort only.</span>
    </div>

    <div class="form-group">
      <label>Remote Time Offset</label>
      <div class="input-row">
        <span id="time-offset-display" class="field-value">${escapeHtml(formatTimeOffset(server.timeOffsetMs))}</span>
        ${!isNew ? `<button id="btn-detect-offset" class="btn-secondary" type="button">Detect Offset</button>` : ''}
      </div>
      <span class="field-hint">Clock skew between local and remote (positive = remote is ahead). Detected automatically on Test Connection.</span>
    </div>

    <div class="form-actions">
      <button id="btn-save">Save</button>
      <button id="btn-test" class="btn-secondary">Test Connection</button>
      ${!isNew && !isDefault ? `<button id="btn-set-default" class="btn-secondary">Set as Default</button>` : ''}
      ${!isNew && isDefault ? `<button disabled class="btn-secondary">Default Server \u2713</button>` : ''}
      ${!isNew ? `<button id="btn-delete" class="btn-danger">Delete</button>` : ''}
    </div>

    <div id="test-connection-result"></div>
  `;

  if (state.testStatus) renderTestResult();

  document.getElementById('f-name')?.addEventListener('input', () => {
    const errEl = document.getElementById('err-name');
    if (errEl) errEl.textContent = '';
  });

  document.getElementById('f-root-path')?.addEventListener('input', () => {
    const errEl = document.getElementById('err-root-path');
    if (errEl) errEl.textContent = '';
  });

  // Show protocol hint on initial render
  updateProtocolHint(server.type);

  document.getElementById('f-type')?.addEventListener('change', (e) => {
    const newType = e.target.value;
    updateProtocolHint(newType);
    // Re-filter credential dropdown for the new protocol
    const credSelect = document.getElementById('f-credential');
    const currentCredId = credSelect.value;
    credSelect.innerHTML = buildCredentialOptions(newType, currentCredId);
  });

  document.getElementById('f-credential')?.addEventListener('change', () => {
    const errEl = document.getElementById('err-credential');
    if (errEl) errEl.textContent = '';
  });

  document.getElementById('btn-browse-root')?.addEventListener('click', () => {
    const credentialId = document.getElementById('f-credential').value;
    const errEl = document.getElementById('err-credential');
    if (!credentialId) {
      if (errEl) errEl.textContent = 'Select a credential before browsing';
      return;
    }
    if (errEl) errEl.textContent = '';
    const currentRoot = document.getElementById('f-root-path').value || '/';
    const serverType = document.getElementById('f-type').value;
    setBrowseLoading(true);
    vscode.postMessage({ command: 'browseDirectory', credentialId, startPath: currentRoot, serverType });
  });

  document.getElementById('btn-manage-creds')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'openCredentials' });
  });

  document.getElementById('btn-save')?.addEventListener('click', () => {
    clearValidationErrors();
    const filePermStr = document.getElementById('f-file-permissions').value.trim();
    const dirPermStr = document.getElementById('f-dir-permissions').value.trim();
    const payload = {
      id: server.id || undefined,
      name: document.getElementById('f-name').value,
      type: document.getElementById('f-type').value,
      credentialId: document.getElementById('f-credential').value,
      rootPath: document.getElementById('f-root-path').value,
    };
    if (filePermStr) { payload.filePermissions = parseInt(filePermStr, 8); }
    if (dirPermStr) { payload.directoryPermissions = parseInt(dirPermStr, 8); }
    // For a brand-new server there's no id to target a standalone saveMapping,
    // so persist any mappings entered on the Mappings tab as part of this save.
    if (!server.id) {
      const { mappings, excludedPaths } = collectMappingInputs();
      payload.mappings = mappings;
      payload.excludedPaths = excludedPaths;
    }
    vscode.postMessage({ command: 'saveServer', payload });
  });

  document.getElementById('btn-test')?.addEventListener('click', () => {
    state.testStatus = null;
    document.getElementById('test-connection-result').className = '';
    document.getElementById('test-connection-result').textContent = 'Connecting\u2026';
    vscode.postMessage({
      command: 'testConnection',
      server: {
        id: server.id || undefined,
        type: document.getElementById('f-type').value,
        credentialId: document.getElementById('f-credential').value,
        rootPath: document.getElementById('f-root-path').value,
      },
    });
  });

  document.getElementById('btn-detect-offset')?.addEventListener('click', () => {
    state.testStatus = null;
    document.getElementById('test-connection-result').className = '';
    document.getElementById('test-connection-result').textContent = 'Detecting offset\u2026';
    vscode.postMessage({
      command: 'detectTimeOffset',
      server: {
        id: server.id || undefined,
        type: document.getElementById('f-type').value,
        credentialId: document.getElementById('f-credential').value,
      },
    });
  });

  document.getElementById('btn-set-default')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'setDefaultServer', id: server.id });
  });

  document.getElementById('btn-delete')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'deleteServer', id: server.id });
  });
}

function renderMappingsTab(server) {
  const el = document.getElementById('mappings-tab');
  if (!el || !server) return;

  // A brand-new server has no id yet. We still render the editor so mappings
  // can be entered before the first save — they ride along in the saveServer
  // payload (see the Connection tab's Save handler).
  const isNew = !server.id;

  // Mappings and excludedPaths live directly on the server object now
  const mappings = server.mappings || [];
  const excludedPaths = server.excludedPaths || [];

  el.innerHTML = `
    <p class="hint">Map local paths (relative to workspace root) to remote paths on the server.</p>

    <div class="section-title">Path Mappings</div>
    <table class="mappings-table">
      <thead>
        <tr>
          <th>Local Path</th>
          <th>Remote Path</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="mappings-body">
        ${mappings.map((m, i) => `
          <tr data-index="${i}">
            <td><input class="m-local" type="text" value="${escapeHtml(m.localPath)}" placeholder="/"></td>
            <td><input class="m-remote" type="text" value="${escapeHtml(m.remotePath)}" placeholder="html"></td>
            <td><button class="btn-remove-mapping" data-index="${i}" title="Remove">\u00d7</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button id="btn-add-mapping" class="btn-secondary">+ Add Mapping</button>

    <div class="section-title" style="margin-top:24px">Excluded Paths</div>
    <p class="hint">Glob patterns separated by commas (e.g. node_modules, *.log, vendor)</p>
    <input id="f-excluded" type="text" value="${escapeHtml(excludedPaths.join(', '))}">

    <div class="form-actions">
      ${isNew
        ? '<p class="hint">Mappings are saved together with the server when you click <strong>Save</strong> on the Connection tab.</p>'
        : '<button id="btn-save-mappings">Save Mappings</button>'}
    </div>
  `;

  document.getElementById('btn-add-mapping')?.addEventListener('click', () => {
    const tbody = document.getElementById('mappings-body');
    const idx = tbody.children.length;
    const row = document.createElement('tr');
    row.dataset.index = idx;
    row.innerHTML = `
      <td><input class="m-local" type="text" value="" placeholder="/"></td>
      <td><input class="m-remote" type="text" value="" placeholder="html"></td>
      <td><button class="btn-remove-mapping" data-index="${idx}" title="Remove">\u00d7</button></td>
    `;
    tbody.appendChild(row);
    wireRemoveButtons();
  });

  wireRemoveButtons();

  document.getElementById('btn-save-mappings')?.addEventListener('click', () => {
    const { mappings, excludedPaths } = collectMappingInputs();
    vscode.postMessage({
      command: 'saveMapping',
      serverId: server.id,
      mappings,
      excludedPaths,
    });
  });
}

// Reads the current Mappings-tab inputs out of the DOM. Both tab contents are
// always present (just hidden), so this works even if the tab was never opened.
function collectMappingInputs() {
  const tbody = document.getElementById('mappings-body');
  const mappings = tbody
    ? Array.from(tbody.querySelectorAll('tr')).map(row => ({
        localPath: row.querySelector('.m-local').value.trim() || '/',
        remotePath: row.querySelector('.m-remote').value.trim(),
      }))
    : [];
  const excludedRaw = document.getElementById('f-excluded')?.value || '';
  const excludedPaths = excludedRaw.split(',').map(s => s.trim()).filter(Boolean);
  return { mappings, excludedPaths };
}

function wireRemoveButtons() {
  document.querySelectorAll('.btn-remove-mapping').forEach(btn => {
    // Replace to remove duplicate listeners
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener('click', () => {
      clone.closest('tr')?.remove();
    });
  });
}

// ─── Hooks tab ──────────────────────────────────────────────────────────────

// Renders one editable row: command input + local/remote select + continue-on-error
// checkbox + remove button. Remote is disabled on FTP (no shell exec over FTP).
// Inline SVG so the icon is self-contained (no asset, no CSP change; VS Code's
// $(icon) codicons don't work in webview HTML).
const ICON_TRASH = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path d="M2.5 4h11M6 4V2.6a.6.6 0 0 1 .6-.6h2.8a.6.6 0 0 1 .6.6V4M4.5 4v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V4M6.7 6.8v4.4M9.3 6.8v4.4"
    stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const ICON_KEY = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <circle cx="5.5" cy="5.5" r="3.2" stroke="currentColor" stroke-width="1.2"/>
  <path d="M7.9 7.9 13.5 13.5M11.3 11.3l1.4-1.4M12.7 12.7l1.3-1.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
</svg>`;

// Unique radio-group name per row so the local/remote segments don't
// cross-select between rows. Only uniqueness matters; the counter is reset
// nowhere (a fresh render just mints higher ids for its fresh DOM).
let hookRowIdCounter = 0;

function hookRowHtml(hook, isFtp) {
  const command = escapeHtml(hook?.command ?? '');
  const location = hook?.location === 'remote' ? 'remote' : 'local';
  const continueOnError = !!hook?.continueOnError;
  const remoteDisabled = isFtp ? 'disabled' : '';
  const remoteTitle = isFtp ? 'title="Remote hooks require SFTP"' : '';
  const group = `hook-loc-${hookRowIdCounter++}`;
  return `
    <div class="hook-row">
      <div class="hook-row-main">
        <input class="hook-command" type="text" value="${command}" placeholder="e.g. npm run build">
        <button class="btn-insert-secret icon-btn" type="button" data-tooltip="Insert a \${secret:NAME} reference" aria-label="Insert secret">${ICON_KEY}</button>
        <button class="btn-remove-hook icon-btn" type="button" data-tooltip="Remove this hook" aria-label="Remove hook">${ICON_TRASH}</button>
      </div>
      <div class="hook-row-meta">
        <div class="segmented hook-location" role="group" aria-label="Where this hook runs">
          <label><input type="radio" name="${group}" class="hook-loc-radio" value="local" ${location === 'local' ? 'checked' : ''}> local</label>
          <label ${remoteTitle}><input type="radio" name="${group}" class="hook-loc-radio" value="remote" ${location === 'remote' ? 'checked' : ''} ${remoteDisabled}> remote</label>
        </div>
        <label class="hook-coe" title="Continue the deploy even if this hook fails">
          <input class="hook-continue" type="checkbox" ${continueOnError ? 'checked' : ''}> continue on error
        </label>
      </div>
      <div class="hook-secret-missing" hidden></div>
      <div class="hook-warning" hidden></div>
    </div>
  `;
}

function hookSectionLabel(label, count) {
  return count > 0 ? `${label} (${count})` : label;
}

function updateHookSectionCount(bodyId, summaryId, label) {
  const body = document.getElementById(bodyId);
  const summary = document.getElementById(summaryId);
  if (!body || !summary) return;
  summary.textContent = hookSectionLabel(label, body.querySelectorAll('.hook-row').length);
}

function refreshHookSectionCounts() {
  updateHookSectionCount('pre-hooks-body', 'pre-hooks-summary', 'Pre-deploy');
  updateHookSectionCount('post-hooks-body', 'post-hooks-summary', 'Post-deploy');
}

// ${secret:NAME} tokens in a command string — names only (mirrors the
// extension-side pattern; names are environment-variable-shaped).
function secretTokenNames(command) {
  const names = [];
  const pattern = /\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let match;
  while ((match = pattern.exec(command || '')) !== null) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

// Every ${secret:NAME} referenced anywhere: saved hooks of ALL servers
// (secrets are project-scoped, not per-server) plus the live, possibly
// unsaved command inputs on this tab.
// Secret names referenced by the hook commands currently in the tab (the live
// DOM), so deleting a hook row immediately drops its "missing" secret entry.
// The live inputs already reflect the selected server's saved hooks (the tab
// renders them) plus any unsaved edits; other servers' refs aren't shown here,
// which is fine — the table still lists every STORED secret regardless.
function referencedSecretNames() {
  const names = [];
  document.querySelectorAll('#hooks-tab .hook-command').forEach(input => {
    for (const name of secretTokenNames(input.value)) {
      if (!names.includes(name)) names.push(name);
    }
  });
  return names;
}

function renderHooksTab(server) {
  const el = document.getElementById('hooks-tab');
  if (!el || !server) return;

  closeSecretMenu(); // a stale popup would point at a soon-to-be-removed input

  const isNew = !server.id;
  const isFtp = isFtpType(server.type);
  const hooks = server.hooks || {};
  const preDeploy = hooks.preDeploy || [];
  const postDeploy = hooks.postDeploy || [];

  const preOpen = state.preDeployOpen !== false ? 'open' : '';
  const postOpen = state.postDeployOpen !== false ? 'open' : '';

  el.innerHTML = `
    <p class="hint">Commands run before/after a deliberate deploy. Trusted workspaces only; shown in the deploy confirmation. Keep secrets out of commands — use <code>\${secret:NAME}</code> from the keychain below.</p>

    <details id="secrets-details" class="hook-details secrets-details">
      <summary id="secrets-summary">Secrets</summary>
      <p class="hint">Project secrets stored in your <strong>OS keychain</strong>, referenced as <code>\${secret:NAME}</code>. Never written to <code>fileferry.json</code>; machine-local, so a teammate re-enters them.</p>
      <div id="secrets-error" class="field-error"></div>
      <div id="secrets-section"></div>
    </details>

    <details id="pre-hooks-details" class="hook-details" ${preOpen}>
      <summary id="pre-hooks-summary">${hookSectionLabel('Pre-deploy', preDeploy.length)}</summary>
      <div id="pre-hooks-body">${preDeploy.map(h => hookRowHtml(h, isFtp)).join('')}</div>
      <button id="btn-add-pre-hook" class="btn-secondary" type="button">+ Add pre-deploy hook</button>
    </details>

    <details id="post-hooks-details" class="hook-details" ${postOpen}>
      <summary id="post-hooks-summary">${hookSectionLabel('Post-deploy', postDeploy.length)}</summary>
      <div id="post-hooks-body">${postDeploy.map(h => hookRowHtml(h, isFtp)).join('')}</div>
      <button id="btn-add-post-hook" class="btn-secondary" type="button">+ Add post-deploy hook</button>
    </details>

    <div class="form-actions">
      ${isNew
        ? '<p class="hint">Save the server on the Connection tab first, then add hooks here.</p>'
        : '<button id="btn-save-hooks" type="button">Save Hooks</button>'}
    </div>
  `;

  // Remember the user's explicit open/collapse choice; renderSecretsSection
  // applies the auto rule (open when something is missing) only until then.
  document.getElementById('secrets-details')?.addEventListener('toggle', (event) => {
    if (event.target.dataset.programmaticToggle) {
      delete event.target.dataset.programmaticToggle;
      return;
    }
    state.secretsSectionOpen = event.target.open;
  });
  document.getElementById('pre-hooks-details')?.addEventListener('toggle', (event) => {
    state.preDeployOpen = event.target.open;
  });
  document.getElementById('post-hooks-details')?.addEventListener('toggle', (event) => {
    state.postDeployOpen = event.target.open;
  });

  const addRow = (bodyId, summaryId, label) => {
    const body = document.getElementById(bodyId);
    if (!body) return;
    body.insertAdjacentHTML('beforeend', hookRowHtml(null, isFtp));
    wireHookRows();
    updateHookSectionCount(bodyId, summaryId, label);
  };
  document.getElementById('btn-add-pre-hook')?.addEventListener('click', () => addRow('pre-hooks-body', 'pre-hooks-summary', 'Pre-deploy'));
  document.getElementById('btn-add-post-hook')?.addEventListener('click', () => addRow('post-hooks-body', 'post-hooks-summary', 'Post-deploy'));

  wireHookRows();
  renderSecretsSection();
  refreshHookSecretIndicators();

  document.getElementById('btn-save-hooks')?.addEventListener('click', () => {
    vscode.postMessage({
      command: 'saveHooks',
      serverId: server.id,
      hooks: collectHookInputs(),
    });
  });
}

function wireHookRows() {
  document.querySelectorAll('.btn-remove-hook').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener('click', () => {
      clone.closest('.hook-row')?.remove();
      refreshHookSectionCounts();
      refreshHookSecretIndicators();
      renderSecretsSection();
    });
  });

  // Missing-secret indicators follow what's typed, live — not just what's saved.
  document.querySelectorAll('#hooks-tab .hook-command').forEach(input => {
    const clone = input.cloneNode(true);
    clone.value = input.value;
    input.replaceWith(clone);
    clone.addEventListener('input', () => {
      refreshHookSecretIndicators();
      renderSecretsSection();
    });
  });

  wireInsertSecretButtons();
}

// ─── Hook secrets (#27b) ─────────────────────────────────────────────────────

// The insert-secret key button opens a popup listing the stored secrets plus a
// "New secret…" entry. One floating menu at a time, positioned under its button
// and appended to the body (so a hooks-tab re-render doesn't strand it — we
// close it explicitly on re-render).
let activeSecretMenu = null;
let secretMenuButton = null;
let secretMenuTargetInput = null;

function closeSecretMenu() {
  if (!activeSecretMenu) return;
  activeSecretMenu.remove();
  activeSecretMenu = null;
  secretMenuButton = null;
  secretMenuTargetInput = null;
  document.removeEventListener('click', onSecretMenuOutside, true);
  document.removeEventListener('keydown', onSecretMenuKey, true);
}

function onSecretMenuOutside(event) {
  if (!activeSecretMenu) return;
  if (activeSecretMenu.contains(event.target) || event.target.closest('.btn-insert-secret')) return;
  closeSecretMenu();
}

function onSecretMenuKey(event) {
  if (event.key === 'Escape') closeSecretMenu();
}

function insertSecretToken(commandInput, name) {
  const token = '${secret:' + name + '}';
  const start = commandInput.selectionStart ?? commandInput.value.length;
  const end = commandInput.selectionEnd ?? commandInput.value.length;
  commandInput.value = commandInput.value.slice(0, start) + token + commandInput.value.slice(end);
  commandInput.focus();
  commandInput.setSelectionRange(start + token.length, start + token.length);
  refreshHookSecretIndicators();
  renderSecretsSection();
}

function openSecretMenu(button) {
  const commandInput = button.closest('.hook-row')?.querySelector('.hook-command');
  if (!commandInput) return;
  closeSecretMenu();
  secretMenuButton = button;
  secretMenuTargetInput = commandInput;

  const items = state.secretNames.length > 0
    ? state.secretNames.map(name =>
        `<button type="button" class="secret-menu-item" data-name="${escapeHtml(name)}">\${secret:${escapeHtml(name)}}</button>`).join('')
    : '<div class="secret-menu-empty">No secrets stored yet</div>';

  const menu = document.createElement('div');
  menu.className = 'secret-menu';
  menu.innerHTML = `${items}<div class="secret-menu-sep"></div><button type="button" class="secret-menu-item secret-menu-new">+ New secret…</button>`;
  document.body.appendChild(menu);

  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;

  menu.querySelector('.secret-menu-new')?.addEventListener('click', () => {
    closeSecretMenu();
    const details = document.getElementById('secrets-details');
    if (details) details.open = true; // user-initiated: the toggle listener records it
    const nameInput = document.getElementById('new-secret-name');
    nameInput?.scrollIntoView({ block: 'center' });
    nameInput?.focus();
  });
  menu.querySelectorAll('.secret-menu-item[data-name]').forEach(item => {
    item.addEventListener('click', () => {
      const target = secretMenuTargetInput;
      closeSecretMenu();
      if (target) insertSecretToken(target, item.dataset.name);
    });
  });

  activeSecretMenu = menu;
  // Attach the dismissers on the next tick so the opening click doesn't close it.
  setTimeout(() => {
    document.addEventListener('click', onSecretMenuOutside, true);
    document.addEventListener('keydown', onSecretMenuKey, true);
  }, 0);
}

function wireInsertSecretButtons() {
  document.querySelectorAll('#hooks-tab .btn-insert-secret').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener('click', (event) => {
      event.stopPropagation();
      if (activeSecretMenu && secretMenuButton === clone) {
        closeSecretMenu();
      } else {
        openSecretMenu(clone);
      }
    });
  });
}

// Per hook row: warn when the command references a ${secret:NAME} that is not
// stored on this machine (fresh clone / moved project / typo).
function refreshHookSecretIndicators() {
  document.querySelectorAll('#hooks-tab .hook-row').forEach(row => {
    const indicator = row.querySelector('.hook-secret-missing');
    const commandInput = row.querySelector('.hook-command');
    if (!indicator || !commandInput) return;
    const missing = secretTokenNames(commandInput.value).filter(name => !state.secretNames.includes(name));
    if (missing.length > 0) {
      indicator.textContent =
        `⚠ References ${missing.map(name => '${secret:' + name + '}').join(', ')} — not set on this machine. Set the value in the Secrets section above.`;
      indicator.hidden = false;
    } else {
      indicator.textContent = '';
      indicator.hidden = true;
    }
  });
}

// One row per known name: stored names plus names referenced by any hook
// command (saved or typed) that aren't stored yet — the table doubles as the
// "what do I need to re-enter on this machine?" checklist.
function secretRowHtml(name, isStored) {
  const escapedName = escapeHtml(name);
  const status = isStored
    ? '<span class="secret-status stored">✓ in OS keychain</span>'
    : '<span class="secret-status missing">⚠ not set on this machine</span>';
  return `
    <div class="secret-row" data-name="${escapedName}">
      <code class="secret-name">${escapedName}</code>
      ${status}
      <input class="secret-value" type="password" autocomplete="off" placeholder="${isStored ? 'enter new value to replace' : 'enter value'}">
      <button class="btn-store-secret" type="button">${isStored ? 'Update' : 'Set value'}</button>
      ${isStored ? '<button class="btn-rename-secret" type="button">Rename</button>' : ''}
      ${isStored ? '<button class="btn-delete-secret" type="button" title="Delete from keychain">Delete</button>' : ''}
    </div>
  `;
}

function renderSecretsSection() {
  const el = document.getElementById('secrets-section');
  if (!el) return;

  const referenced = referencedSecretNames();
  const missingNames = referenced.filter(name => !state.secretNames.includes(name));

  updateSecretsSummary(missingNames.length);
  applySecretsSectionOpenState(missingNames.length > 0);

  // This re-renders on every hook-command keystroke (missing rows follow the
  // typing), so carry typed-but-unsubmitted field values across the rebuild.
  const typedValues = {};
  el.querySelectorAll('.secret-row').forEach(row => {
    const value = row.querySelector('.secret-value')?.value;
    if (value) typedValues[row.dataset.name] = value;
  });
  const typedAddName = document.getElementById('new-secret-name')?.value ?? '';
  const typedAddValue = document.getElementById('new-secret-value')?.value ?? '';

  const rows = [
    ...state.secretNames.map(name => secretRowHtml(name, true)),
    ...missingNames.map(name => secretRowHtml(name, false)),
  ].join('');

  el.innerHTML = `
    <div id="secrets-body">${rows || '<p class="hint">No secrets yet. Add one below, then reference it in a command as <code>\${secret:NAME}</code>.</p>'}</div>
    <div class="secret-add-row">
      <input id="new-secret-name" type="text" autocomplete="off" spellcheck="false" placeholder="NAME (letters, digits, _)">
      <input id="new-secret-value" type="password" autocomplete="off" placeholder="value">
      <button id="btn-add-secret" type="button">Add secret</button>
    </div>
  `;

  el.querySelectorAll('.secret-row').forEach(row => {
    if (typedValues[row.dataset.name]) {
      row.querySelector('.secret-value').value = typedValues[row.dataset.name];
    }
  });
  document.getElementById('new-secret-name').value = typedAddName;
  document.getElementById('new-secret-value').value = typedAddValue;

  wireSecretRows();
}

function updateSecretsSummary(missingCount) {
  const summary = document.getElementById('secrets-summary');
  if (!summary) return;
  const storedCount = state.secretNames.length;
  const parts = [];
  if (storedCount > 0) parts.push(`${storedCount} stored`);
  if (missingCount > 0) parts.push(`${missingCount} missing on this machine`);
  summary.textContent = parts.length > 0 ? `Secrets — ${parts.join(' · ')}` : 'Secrets';
}

// Auto-open while something is missing (the fresh-clone case); once the user
// toggles the section themselves, their choice wins for the panel's lifetime.
function applySecretsSectionOpenState(hasMissing) {
  const details = document.getElementById('secrets-details');
  if (!details) return;
  const shouldOpen = state.secretsSectionOpen ?? hasMissing;
  if (details.open !== shouldOpen) {
    details.dataset.programmaticToggle = 'true';
    details.open = shouldOpen;
  }
}

function wireSecretRows() {
  const clearError = () => {
    const errorEl = document.getElementById('secrets-error');
    if (errorEl) errorEl.textContent = '';
  };

  document.querySelectorAll('#secrets-section .secret-row').forEach(row => {
    const name = row.dataset.name;
    const valueInput = row.querySelector('.secret-value');

    row.querySelector('.btn-store-secret')?.addEventListener('click', () => {
      if (!valueInput.value) return;
      clearError();
      vscode.postMessage({ command: 'storeSecret', name, value: valueInput.value });
      valueInput.value = '';
    });

    row.querySelector('.btn-delete-secret')?.addEventListener('click', () => {
      clearError();
      vscode.postMessage({ command: 'deleteSecret', name });
    });

    // Rename swaps the name cell for an input; Enter confirms, Escape cancels.
    row.querySelector('.btn-rename-secret')?.addEventListener('click', () => {
      const nameEl = row.querySelector('.secret-name');
      if (!nameEl || row.querySelector('.secret-rename-input')) return;
      const renameInput = document.createElement('input');
      renameInput.className = 'secret-rename-input';
      renameInput.type = 'text';
      renameInput.value = name;
      renameInput.spellcheck = false;
      nameEl.replaceWith(renameInput);
      renameInput.focus();
      renameInput.select();
      renameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          const newName = renameInput.value.trim();
          if (newName && newName !== name) {
            clearError();
            vscode.postMessage({ command: 'renameSecret', name, newName });
          } else {
            renderSecretsSection();
          }
        } else if (event.key === 'Escape') {
          renderSecretsSection();
        }
      });
    });
  });

  document.getElementById('btn-add-secret')?.addEventListener('click', () => {
    const nameInput = document.getElementById('new-secret-name');
    const valueInput = document.getElementById('new-secret-value');
    const name = nameInput?.value.trim();
    if (!name || !valueInput?.value) return;
    clearError();
    vscode.postMessage({ command: 'storeSecret', name, value: valueInput.value });
    // Clear both fields — the secretsUpdated re-render carries live input values
    // across, so clearing here leaves a clean add-row after the secret lands.
    nameInput.value = '';
    valueInput.value = '';
  });
}

// Reads one hooks list (#pre-hooks-body / #post-hooks-body) out of the DOM,
// dropping rows whose command is blank.
function collectHookList(bodyId) {
  const body = document.getElementById(bodyId);
  if (!body) return [];
  return Array.from(body.querySelectorAll('.hook-row'))
    .map(row => {
      const command = row.querySelector('.hook-command').value.trim();
      const location = row.querySelector('.hook-loc-radio:checked')?.value === 'remote' ? 'remote' : 'local';
      const continueOnError = row.querySelector('.hook-continue').checked;
      const hook = { command, location };
      if (continueOnError) hook.continueOnError = true;
      return hook;
    })
    .filter(hook => hook.command.length > 0);
}

function collectHookInputs() {
  return {
    preDeploy: collectHookList('pre-hooks-body'),
    postDeploy: collectHookList('post-hooks-body'),
  };
}

// On a save-time secret-scan hit, flag every matching command row inline. The
// warning is advisory and non-blocking — the hooks are already saved. The
// one-click fix stores the flagged literal in the OS keychain and rewrites the
// saved command to a ${secret:NAME} reference (#27b).
function showHookSecretWarnings(commands) {
  const flagged = new Set(commands);
  const server = getSelectedServer();
  document.querySelectorAll('#hooks-tab .hook-row').forEach(row => {
    const warningEl = row.querySelector('.hook-warning');
    if (!warningEl) return;
    const command = row.querySelector('.hook-command').value.trim();
    if (flagged.has(command)) {
      warningEl.innerHTML = `
        ⚠ This looks like it contains a secret — <code>fileferry.json</code> is committed to git.
        Name it and move the value to the OS keychain:
        <span class="move-secret-form">
          <input class="move-secret-name" type="text" spellcheck="false" placeholder="NAME (letters, digits, _)">
          <button class="btn-move-secret" type="button">Move to keychain</button>
        </span>`;
      warningEl.hidden = false;
      warningEl.querySelector('.btn-move-secret')?.addEventListener('click', () => {
        const name = warningEl.querySelector('.move-secret-name')?.value.trim();
        if (!name || !server?.id) return;
        vscode.postMessage({ command: 'moveSecretToKeychain', serverId: server.id, hookCommand: command, name });
      });
    } else {
      warningEl.textContent = '';
      warningEl.hidden = true;
    }
  });
}

function renderTestResult() {
  const el = document.getElementById('test-connection-result');
  if (!el || !state.testStatus) return;
  el.className = state.testStatus.success ? 'success' : 'error';
  el.textContent = '';

  const main = document.createElement('div');
  main.textContent = state.testStatus.success
    ? `\u2713 ${state.testStatus.message}`
    : `\u2717 ${state.testStatus.message}`;
  el.appendChild(main);

  if (state.testStatus.success && state.testStatus.warning) {
    const warn = document.createElement('div');
    warn.className = 'warning';
    warn.textContent = `\u26a0 ${state.testStatus.warning}`;
    el.appendChild(warn);
  }
}

function formatTimeOffset(offsetMs) {
  if (offsetMs === undefined || offsetMs === null) return 'Not detected';
  const abs = Math.abs(offsetMs);
  if (abs < 1000) return `${offsetMs >= 0 ? '+' : ''}${offsetMs}ms`;
  const seconds = (offsetMs / 1000).toFixed(1);
  return `${offsetMs >= 0 ? '+' : ''}${seconds}s`;
}

function renderTimeOffset(offsetMs) {
  const el = document.getElementById('time-offset-display');
  if (el) el.textContent = formatTimeOffset(offsetMs);
}

function showValidationErrors(errors) {
  if (errors.name) {
    const el = document.getElementById('err-name');
    if (el) el.textContent = errors.name;
  }
  if (errors.credentialId) {
    const el = document.getElementById('err-credential');
    if (el) el.textContent = errors.credentialId;
  }
  if (errors.rootPath) {
    const el = document.getElementById('err-root-path');
    if (el) el.textContent = errors.rootPath;
  }
}

function clearValidationErrors() {
  document.querySelectorAll('.field-error').forEach(el => el.textContent = '');
}
