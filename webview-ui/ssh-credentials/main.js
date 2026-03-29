// FileFerry SSH Credentials Manager webview
// Runs inside the VSCode webview iframe.
// SECURITY: Passwords typed here travel to the extension ONCE on save/test, then are discarded.
// The init message never contains secret fields — passwords are stored in the OS keychain only.

const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  credentials: [],
  selectedId: null,
  editingNew: false,
  testStatus: null,  // { success, message } | null
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

vscode.postMessage({ command: 'ready' });

// ─── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', ({ data: msg }) => {
  switch (msg.command) {
    case 'init':
      state.credentials = msg.credentials || [];
      if (!state.selectedId && state.credentials.length > 0) {
        state.selectedId = state.credentials[0].id;
      }
      render();
      break;

    case 'credentialSaved':
      upsert(msg.credential);
      state.selectedId = msg.credential.id;
      state.editingNew = false;
      state.testStatus = null;
      render();
      break;

    case 'credentialDeleted':
      state.credentials = state.credentials.filter(c => c.id !== msg.id);
      state.selectedId = state.credentials[0]?.id ?? null;
      state.editingNew = false;
      render();
      break;

    case 'testResult':
      state.testStatus = { success: msg.success, message: msg.message };
      renderTestResult();
      break;

    case 'validationError':
      showValidationErrors(msg.errors);
      break;

    case 'warning':
      showFieldWarning(msg.field, msg.message);
      break;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function upsert(cred) {
  const idx = state.credentials.findIndex(c => c.id === cred.id);
  if (idx >= 0) state.credentials[idx] = cred;
  else state.credentials.push(cred);
}

function getSelected() {
  if (state.editingNew) {
    return { id: '', name: '', host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '' };
  }
  return state.credentials.find(c => c.id === state.selectedId) ?? null;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  renderList();
  renderDetail();
}

function renderList() {
  const el = document.getElementById('credential-list-panel');
  if (!el) return;

  el.innerHTML = `
    <div class="panel-header">
      <span>SSH Credentials</span>
      <button id="add-btn" title="Add credential">+</button>
    </div>
    <ul class="server-list">
      ${state.credentials.map(c => `
        <li class="server-item ${c.id === state.selectedId && !state.editingNew ? 'selected' : ''}"
            data-id="${escapeHtml(c.id)}">
          <span class="server-name">${escapeHtml(c.name)}</span>
          <span class="auth-badge">${escapeHtml(c.authMethod)}</span>
        </li>
      `).join('')}
      ${state.editingNew ? `
        <li class="server-item selected">
          <span class="server-name"><em>New Credential</em></span>
        </li>` : ''}
    </ul>
  `;

  document.getElementById('add-btn')?.addEventListener('click', () => {
    state.editingNew = true;
    state.selectedId = null;
    state.testStatus = null;
    render();
  });

  document.querySelectorAll('.server-item[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedId = el.dataset.id;
      state.editingNew = false;
      state.testStatus = null;
      render();
    });
  });
}

function renderDetail() {
  const el = document.getElementById('credential-detail-panel');
  if (!el) return;

  const cred = getSelected();
  if (!cred) {
    el.innerHTML = `<div class="empty-state">Select or add a credential to get started</div>`;
    return;
  }

  const isNew = !cred.id;
  const authMethod = cred.authMethod || 'password';

  el.innerHTML = `
    <div class="detail-form">
      <div class="form-group">
        <label for="f-name">Name</label>
        <input id="f-name" type="text" value="${escapeHtml(cred.name)}" placeholder="e.g. Production Server">
        <span class="field-error" id="err-name"></span>
      </div>

      <div class="form-row">
        <div class="form-group flex-grow">
          <label for="f-host">Host</label>
          <input id="f-host" type="text" value="${escapeHtml(cred.host)}" placeholder="example.com">
          <span class="field-error" id="err-host"></span>
        </div>
        <div class="form-group port-group">
          <label for="f-port">Port</label>
          <input id="f-port" type="number" value="${cred.port || 22}" min="1" max="65535">
        </div>
      </div>

      <div class="form-group">
        <label for="f-username">Username</label>
        <input id="f-username" type="text" value="${escapeHtml(cred.username)}" placeholder="deploy">
        <span class="field-error" id="err-username"></span>
      </div>

      <div class="form-group">
        <label for="f-auth-method">Authentication</label>
        <select id="f-auth-method">
          <option value="password" ${authMethod === 'password' ? 'selected' : ''}>Password</option>
          <option value="key" ${authMethod === 'key' ? 'selected' : ''}>Private Key</option>
          <option value="agent" ${authMethod === 'agent' ? 'selected' : ''}>SSH Agent</option>
        </select>
      </div>

      <div id="auth-fields"></div>

      <div id="test-connection-result"></div>

      <div class="form-actions">
        <button id="btn-save">Save</button>
        <button id="btn-test" class="btn-secondary">Test Connection</button>
        ${!isNew ? `<button id="btn-delete" class="btn-danger">Delete</button>` : ''}
      </div>
    </div>
  `;

  renderAuthFields(authMethod);
  if (state.testStatus) renderTestResult();

  // Clear field errors as the user types
  ['f-name', 'f-host', 'f-username'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      const errEl = document.getElementById(`err-${id.slice(2)}`);
      if (errEl) errEl.textContent = '';
    });
  });

  // Re-render auth fields when auth method changes
  document.getElementById('f-auth-method')?.addEventListener('change', (e) => {
    renderAuthFields(e.target.value);
  });

  document.getElementById('btn-save')?.addEventListener('click', () => {
    clearValidationErrors();
    const payload = buildPayload(cred.id);
    vscode.postMessage({ command: 'saveCredential', payload });
  });

  document.getElementById('btn-test')?.addEventListener('click', () => {
    state.testStatus = null;
    const resultEl = document.getElementById('test-connection-result');
    if (resultEl) { resultEl.className = ''; resultEl.textContent = 'Connecting…'; }
    const payload = buildPayload(cred.id);
    vscode.postMessage({
      command: 'testConnection',
      credential: payload.credential,
      password: payload.password,
      passphrase: payload.passphrase,
    });
  });

  document.getElementById('btn-delete')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'deleteCredential', id: cred.id });
  });
}

function renderAuthFields(authMethod) {
  const el = document.getElementById('auth-fields');
  if (!el) return;

  if (authMethod === 'password') {
    el.innerHTML = `
      <div class="form-group">
        <label for="f-password">Password</label>
        <input id="f-password" type="password" placeholder="Leave blank to keep existing">
        <span class="field-hint">Leave blank to keep the stored password unchanged</span>
      </div>
    `;
  } else if (authMethod === 'key') {
    const cred = getSelected();
    el.innerHTML = `
      <div class="form-group">
        <label for="f-key-path">Private Key Path</label>
        <input id="f-key-path" type="text" value="${escapeHtml(cred?.privateKeyPath)}"
               placeholder="/home/user/.ssh/id_rsa">
        <span class="field-error" id="err-privateKeyPath"></span>
        <span class="field-warning" id="warn-privateKeyPath"></span>
      </div>
      <div class="form-group">
        <label for="f-passphrase">Passphrase</label>
        <input id="f-passphrase" type="password" placeholder="Leave blank if none / to keep existing">
        <span class="field-hint">Leave blank to keep the stored passphrase unchanged</span>
      </div>
    `;
    document.getElementById('f-key-path')?.addEventListener('input', () => {
      const errEl = document.getElementById('err-privateKeyPath');
      if (errEl) errEl.textContent = '';
    });
  } else if (authMethod === 'agent') {
    el.innerHTML = `
      <p class="hint">
        Uses the SSH agent running on your system (<code>SSH_AUTH_SOCK</code>).
        No password or key file needed — make sure your key is added to the agent with
        <code>ssh-add</code>.
      </p>
    `;
  }
}

function buildPayload(existingId) {
  const authMethod = document.getElementById('f-auth-method')?.value || 'password';
  const credential = {
    id: existingId || undefined,
    name: document.getElementById('f-name')?.value || '',
    host: document.getElementById('f-host')?.value || '',
    port: parseInt(document.getElementById('f-port')?.value || '22', 10),
    username: document.getElementById('f-username')?.value || '',
    authMethod,
    privateKeyPath: authMethod === 'key'
      ? (document.getElementById('f-key-path')?.value || '')
      : undefined,
  };
  const password = authMethod === 'password'
    ? (document.getElementById('f-password')?.value || '')
    : undefined;
  const passphrase = authMethod === 'key'
    ? (document.getElementById('f-passphrase')?.value || '')
    : undefined;

  return { credential, password, passphrase };
}

function renderTestResult() {
  const el = document.getElementById('test-connection-result');
  if (!el || !state.testStatus) return;
  el.className = state.testStatus.success ? 'success' : 'error';
  el.textContent = state.testStatus.success
    ? `✓ ${state.testStatus.message}`
    : `✗ ${state.testStatus.message}`;
}

function showValidationErrors(errors) {
  Object.entries(errors).forEach(([field, msg]) => {
    const el = document.getElementById(`err-${field}`);
    if (el) el.textContent = msg;
  });
}

function showFieldWarning(field, message) {
  const el = document.getElementById(`warn-${field}`);
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
}

function clearValidationErrors() {
  document.querySelectorAll('.field-error').forEach(el => el.textContent = '');
  document.querySelectorAll('.field-warning').forEach(el => el.textContent = '');
}
