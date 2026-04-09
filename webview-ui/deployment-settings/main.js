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

    case 'testResult':
      state.testStatus = { success: msg.success, message: msg.message };
      renderTestResult();
      break;

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
      </div>
      <div id="connection-tab" class="tab-content active"></div>
      <div id="mappings-tab" class="tab-content"></div>
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

    <div class="form-actions">
      <button id="btn-save">Save</button>
      ${!isNew ? `<button id="btn-test" class="btn-secondary">Test Connection</button>` : ''}
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
    vscode.postMessage({ command: 'saveServer', payload });
  });

  document.getElementById('btn-test')?.addEventListener('click', () => {
    state.testStatus = null;
    document.getElementById('test-connection-result').className = '';
    document.getElementById('test-connection-result').textContent = 'Connecting\u2026';
    vscode.postMessage({ command: 'testConnection', serverId: server.id });
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
  if (!el || !server?.id) return;

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
      <button id="btn-save-mappings">Save Mappings</button>
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
    const tbody = document.getElementById('mappings-body');
    const updatedMappings = Array.from(tbody.querySelectorAll('tr')).map(row => ({
      localPath: row.querySelector('.m-local').value.trim() || '/',
      remotePath: row.querySelector('.m-remote').value.trim(),
    }));
    const excludedRaw = document.getElementById('f-excluded').value;
    const updatedExcluded = excludedRaw.split(',').map(s => s.trim()).filter(Boolean);

    vscode.postMessage({
      command: 'saveMapping',
      serverId: server.id,
      mappings: updatedMappings,
      excludedPaths: updatedExcluded,
    });
  });
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

function renderTestResult() {
  const el = document.getElementById('test-connection-result');
  if (!el || !state.testStatus) return;
  el.className = state.testStatus.success ? 'success' : 'error';
  el.textContent = state.testStatus.success
    ? `\u2713 ${state.testStatus.message}`
    : `\u2717 ${state.testStatus.message}`;
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
