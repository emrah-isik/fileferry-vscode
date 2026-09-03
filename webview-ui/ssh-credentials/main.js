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
  // Unsaved jump-host picker edits for the credential currently on the form
  // (18a-2b, Q16). null = not initialised for this selection; reset whenever
  // the selection changes so drafts never leak between credentials. Ids are
  // stored, names are display-only.
  draftJumpHosts: null,
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

vscode.postMessage({ command: 'ready' });

// ─── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', ({ data: msg }) => {
  switch (msg.command) {
    case 'init':
      state.credentials = msg.credentials || [];
      if (msg.selectedId && state.credentials.some(c => c.id === msg.selectedId)) {
        // The opener asked for a specific credential (Manage… from a
        // server's credential dropdown).
        state.selectedId = msg.selectedId;
      } else if (!state.selectedId && state.credentials.length > 0) {
        state.selectedId = state.credentials[0].id;
      }
      state.draftJumpHosts = null;
      render();
      break;

    case 'selectCredential':
      if (state.credentials.some(c => c.id === msg.id)) {
        state.selectedId = msg.id;
        state.editingNew = false;
        state.testStatus = null;
        state.draftJumpHosts = null;
        render();
      }
      break;

    case 'credentialSaved':
      upsert(msg.credential);
      state.selectedId = msg.credential.id;
      state.editingNew = false;
      state.testStatus = null;
      state.draftJumpHosts = null;
      render();
      break;

    case 'credentialDeleted':
      state.credentials = state.credentials.filter(c => c.id !== msg.id);
      state.selectedId = state.credentials[0]?.id ?? null;
      state.editingNew = false;
      state.draftJumpHosts = null;
      render();
      break;

    case 'testResult':
      // hopIndex/hopHost present when a jump-host chain failed at a specific
      // hop (18a-2b, Q16) — the display names the hop, not just "failed".
      state.testStatus = { success: msg.success, message: msg.message, hopIndex: msg.hopIndex, hopHost: msg.hopHost };
      renderTestResult();
      break;

    case 'validationError':
      showValidationErrors(msg.errors);
      break;

    case 'warning':
      showFieldWarning(msg.field, msg.message);
      break;

    case 'privateKeySelected': {
      const input = document.getElementById('f-key-path');
      if (input) input.value = msg.path;
      break;
    }

    case 'sshConfigSummary':
      renderSshConfigSummary(msg.status, msg.lines || []);
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

// Host/Username field copy depends on whether the credential resolves from
// ~/.ssh/config. Shared by the initial render and the live checkbox toggle so
// the two never drift apart.
function sshAliasLabels(on) {
  return on
    ? { host: 'Host (SSH config alias)', hostPlaceholder: 'prod', userPlaceholder: 'from ~/.ssh/config' }
    : { host: 'Host', hostPlaceholder: 'example.com', userPlaceholder: 'deploy' };
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
      <span>Credentials</span>
      <button id="add-btn" title="Add credential">+</button>
    </div>
    <ul class="server-list">
      ${state.credentials.map(c => `
        <li class="server-item ${c.id === state.selectedId && !state.editingNew ? 'selected' : ''}"
            data-id="${escapeHtml(c.id)}">
          <span class="server-name">${escapeHtml(c.name)}</span>
          <span class="auth-badge">${escapeHtml(c.authMethod)}</span>
          <button class="btn-clone" data-id="${escapeHtml(c.id)}" title="Clone credential" tabindex="-1">⎘</button>
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
    state.draftJumpHosts = null;
    render();
  });

  document.querySelectorAll('.server-item[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedId = el.dataset.id;
      state.editingNew = false;
      state.testStatus = null;
      state.draftJumpHosts = null;
      render();
    });
  });

  document.querySelectorAll('.btn-clone').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ command: 'cloneCredential', id: btn.dataset.id });
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
  const sshAlias = !!cred.useSshConfig;
  const labels = sshAliasLabels(sshAlias);

  el.innerHTML = `
    <div class="detail-form">
      <div class="form-group">
        <label for="f-name">Name</label>
        <input id="f-name" type="text" value="${escapeHtml(cred.name)}" placeholder="e.g. Production Server">
        <span class="field-error" id="err-name"></span>
      </div>

      <div class="form-row">
        <div class="form-group flex-grow">
          <label for="f-host" id="lbl-host">${labels.host}</label>
          <input id="f-host" type="text" value="${escapeHtml(cred.host)}" placeholder="${labels.hostPlaceholder}">
          <span class="field-error" id="err-host"></span>
        </div>
        <div class="form-group port-group">
          <label for="f-port">Port</label>
          <input id="f-port" type="number" value="${cred.port || 22}" min="1" max="65535">
        </div>
      </div>

      <div class="form-group checkbox-group">
        <label class="checkbox-label">
          <input id="f-use-ssh-config" type="checkbox" ${sshAlias ? 'checked' : ''}>
          Resolve from <code>~/.ssh/config</code>
        </label>
        <span class="field-hint">Treat Host as an <code>~/.ssh/config</code> alias — HostName, Port, User, and IdentityFile are read from your SSH config at connect time. SFTP only.</span>
        <div id="ssh-config-summary" class="ssh-config-summary"></div>
      </div>

      <div class="form-group">
        <label for="f-username">Username</label>
        <input id="f-username" type="text" value="${escapeHtml(cred.username)}" placeholder="${labels.userPlaceholder}">
        <span class="field-error" id="err-username"></span>
      </div>

      <div class="form-group">
        <label for="f-auth-method">Authentication</label>
        <select id="f-auth-method">
          <option value="password" ${authMethod === 'password' ? 'selected' : ''}>Password</option>
          <option value="key" ${authMethod === 'key' ? 'selected' : ''}>Private Key</option>
          <option value="agent" ${authMethod === 'agent' ? 'selected' : ''}>SSH Agent</option>
          <option value="keyboard-interactive" ${authMethod === 'keyboard-interactive' ? 'selected' : ''}>Keyboard Interactive (2FA)</option>
        </select>
      </div>

      <div id="auth-fields"></div>

      <div class="form-group" id="jump-hosts-section"></div>

      <div id="test-connection-result"></div>

      <div class="form-actions">
        <button id="btn-save">Save</button>
        <button id="btn-test" class="btn-secondary">Test Connection</button>
        ${!isNew ? `<button id="btn-delete" class="btn-danger">Delete</button>` : ''}
      </div>
    </div>
  `;

  renderAuthFields(authMethod);
  if (state.draftJumpHosts === null) {
    state.draftJumpHosts = (cred.jumpHosts || []).slice();
  }
  renderJumpHostPicker(cred);
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

  // Toggle SSH-config alias mode in place — update labels/placeholders without a
  // full re-render so typed-but-unsaved field values are preserved.
  document.getElementById('f-use-ssh-config')?.addEventListener('change', (e) => {
    const next = sshAliasLabels(e.target.checked);
    const hostLabel = document.getElementById('lbl-host');
    if (hostLabel) hostLabel.textContent = next.host;
    const hostInput = document.getElementById('f-host');
    if (hostInput) hostInput.placeholder = next.hostPlaceholder;
    const userInput = document.getElementById('f-username');
    if (userInput) userInput.placeholder = next.userPlaceholder;
    // The previous resolution summary no longer reflects the current mode.
    const summary = document.getElementById('ssh-config-summary');
    if (summary) summary.innerHTML = '';
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
        <div class="input-with-button">
          <input id="f-key-path" type="text" value="${escapeHtml(cred?.privateKeyPath)}"
                 placeholder="/home/user/.ssh/id_rsa">
          <button id="btn-browse-key" class="btn-secondary btn-small" type="button">Browse</button>
        </div>
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
    document.getElementById('btn-browse-key')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'browsePrivateKey' });
    });
  } else if (authMethod === 'agent') {
    el.innerHTML = `
      <p class="hint">
        Uses the SSH agent running on your system (<code>SSH_AUTH_SOCK</code>).
        No password or key file needed — make sure your key is added to the agent with
        <code>ssh-add</code>.
      </p>
    `;
  } else if (authMethod === 'keyboard-interactive') {
    el.innerHTML = `
      <p class="hint">
        The server will send authentication challenges (e.g. a 2FA code) at connection time.
        You'll be prompted to respond in VS Code when connecting.
      </p>
    `;
  }
}

// Ordered jump-host picker (18a-2b, Q16). Mirrors validateSshCredential's
// chain rules in the UI: a credential cannot hop through itself or through a
// credential that has hops of its own (chains are flat), and a credential
// other chains hop through cannot get hops. Re-renders only its own section —
// a full renderDetail would wipe typed-but-unsaved form fields.
function renderJumpHostPicker(cred) {
  const el = document.getElementById('jump-hosts-section');
  if (!el) return;

  const draft = state.draftJumpHosts || [];
  const usedAsHopBy = state.credentials.filter(
    c => c.id !== cred.id && (c.jumpHosts || []).includes(cred.id)
  );

  if (usedAsHopBy.length > 0) {
    el.innerHTML = `
      <label>Jump hosts</label>
      <span class="field-hint">This credential is used as a jump host by
        ${usedAsHopBy.map(c => escapeHtml(`"${c.name}"`)).join(', ')} —
        a jump host cannot have jump hosts of its own.</span>
    `;
    return;
  }

  const eligible = state.credentials.filter(c =>
    c.id !== cred.id &&
    !(c.jumpHosts && c.jumpHosts.length > 0) &&
    !draft.includes(c.id)
  );

  const rows = draft.map((hopId, index) => {
    const hop = state.credentials.find(c => c.id === hopId);
    const label = hop
      ? `${escapeHtml(hop.name)} <span class="jump-host-target">(${escapeHtml(hop.username)}@${escapeHtml(hop.host)}:${escapeHtml(hop.port)})</span>`
      : `<em>missing credential</em> <span class="jump-host-target">(${escapeHtml(hopId)})</span>`;
    return `
      <li class="jump-host-row">
        <span class="jump-host-order">${index + 1}.</span>
        <span class="jump-host-name">${label}</span>
        <button class="btn-hop-up btn-icon" data-index="${index}" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn-hop-down btn-icon" data-index="${index}" title="Move down" ${index === draft.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn-hop-remove btn-icon" data-index="${index}" title="Remove jump host">✕</button>
      </li>
    `;
  }).join('');

  el.innerHTML = `
    <label for="f-add-jump-host">Jump hosts</label>
    ${draft.length > 0 ? `<ol class="jump-host-list">${rows}</ol>` : ''}
    <select id="f-add-jump-host" ${eligible.length === 0 ? 'disabled' : ''}>
      <option value="">${eligible.length === 0 ? '— No eligible credentials —' : '— Add jump host… —'}</option>
      ${eligible.map(c => `
        <option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.username)}@${escapeHtml(c.host)}:${escapeHtml(c.port)})</option>
      `).join('')}
    </select>
    <span class="field-error" id="err-jumpHosts"></span>
    <span class="field-hint">Connections tunnel through these hosts in order (first → last)
      before reaching this one. Credentials that have jump hosts themselves are not
      offered — chains cannot be nested. SFTP only.</span>
  `;

  document.getElementById('f-add-jump-host')?.addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) return;
    state.draftJumpHosts = [...draft, id];
    renderJumpHostPicker(cred);
  });

  el.querySelectorAll('.btn-hop-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      state.draftJumpHosts = draft.filter((_, i) => i !== index);
      renderJumpHostPicker(cred);
    });
  });

  const swap = (index, otherIndex) => {
    const next = draft.slice();
    [next[index], next[otherIndex]] = [next[otherIndex], next[index]];
    state.draftJumpHosts = next;
    renderJumpHostPicker(cred);
  };
  el.querySelectorAll('.btn-hop-up').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      if (index > 0) swap(index, index - 1);
    });
  });
  el.querySelectorAll('.btn-hop-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      if (index < draft.length - 1) swap(index, index + 1);
    });
  });
}

function buildPayload(existingId) {
  const authMethod = document.getElementById('f-auth-method')?.value || 'password';
  // Fields without form controls (agentSocketPath) pass through from the
  // stored credential — a save of an unrelated field must never drop them.
  // jumpHosts comes from the picker draft (Q16), falling back to the stored
  // value only if the picker never initialised for this selection.
  const stored = state.credentials.find(c => c.id === existingId);
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
    agentSocketPath: stored?.agentSocketPath,
    useSshConfig: document.getElementById('f-use-ssh-config')?.checked || false,
    jumpHosts: state.draftJumpHosts !== null ? state.draftJumpHosts.slice() : stored?.jumpHosts,
  };
  const password = authMethod === 'password'
    ? (document.getElementById('f-password')?.value || '')
    : undefined;
  const passphrase = authMethod === 'key'
    ? (document.getElementById('f-passphrase')?.value || '')
    : undefined;

  return { credential, password, passphrase };
}

function renderSshConfigSummary(status, lines) {
  const el = document.getElementById('ssh-config-summary');
  if (!el) return;
  el.className = 'ssh-config-summary ' + (status === 'matched' ? 'resolved' : 'fallback');
  el.innerHTML = '';
  // textContent (not innerHTML) — values come from ~/.ssh/config and the host
  // field, so they must never be interpreted as markup.
  lines.forEach((line, i) => {
    const row = document.createElement('div');
    row.className = i === 0 ? 'summary-headline' : 'summary-note';
    const prefix = i === 0 ? (status === 'matched' ? '✓ ' : '⚠ ') : '';
    row.textContent = prefix + line;
    el.appendChild(row);
  });
}

function renderTestResult() {
  const el = document.getElementById('test-connection-result');
  if (!el || !state.testStatus) return;
  el.className = state.testStatus.success ? 'success' : 'error';
  if (state.testStatus.success) {
    el.textContent = `✓ ${state.testStatus.message}`;
  } else if (state.testStatus.hopHost !== undefined) {
    el.textContent = `✗ Jump host ${state.testStatus.hopHost} (hop ${state.testStatus.hopIndex + 1}) failed: ${state.testStatus.message}`;
  } else {
    el.textContent = `✗ ${state.testStatus.message}`;
  }
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
