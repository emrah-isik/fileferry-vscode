// FileFerry Upload History webview
// Runs inside the VSCode webview iframe — no Node.js, no VSCode API access.
// All data persistence goes through postMessage to the extension.

const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  entries: [],
  servers: [],
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

vscode.postMessage({ command: 'ready' });

// ─── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', ({ data: msg }) => {
  switch (msg.command) {
    case 'init':
      state.entries = msg.entries || [];
      state.servers = msg.servers || [];
      render();
      break;

    case 'filtered':
      state.entries = msg.entries || [];
      renderTable();
      break;

    case 'cleared':
      state.entries = [];
      renderTable();
      break;
  }
});

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <h2>Upload History</h2>
    <div class="toolbar">
      <div class="filters">
        <select id="filter-server">
          <option value="">All servers</option>
          ${state.servers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
        <select id="filter-result">
          <option value="">All results</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input type="text" id="filter-search" placeholder="Search file path..." />
      </div>
      <div class="actions">
        <button id="btn-refresh" class="action-btn">Refresh</button>
        <button id="btn-clear" class="action-btn danger">Clear History</button>
      </div>
    </div>
    <div id="table-container"></div>
  `;

  document.getElementById('filter-server')?.addEventListener('change', sendFilter);
  document.getElementById('filter-result')?.addEventListener('change', sendFilter);
  document.getElementById('filter-search')?.addEventListener('input', sendFilter);
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'ready' });
  });
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (confirm('Clear all upload history? This cannot be undone.')) {
      vscode.postMessage({ command: 'clear' });
    }
  });

  renderTable();
}

function renderTable() {
  const container = document.getElementById('table-container');
  if (!container) return;

  if (state.entries.length === 0) {
    container.innerHTML = '<p class="empty-state">No upload history yet. History is recorded automatically when you upload files.</p>';
    return;
  }

  // Sort most recent first
  const sorted = [...state.entries].sort((a, b) => b.timestamp - a.timestamp);

  const rows = sorted.map(e => {
    const err = e.error || '';
    const errorCellClass = err ? 'col-error has-content' : 'col-error';
    return `
    <tr class="result-${e.result}">
      <td class="col-time">${formatTimestamp(e.timestamp)}</td>
      <td class="col-file" title="${escapeHtml(e.localPath || e.remotePath)}">${escapeHtml(shortPath(e.localPath || e.remotePath))}</td>
      <td class="col-server">${escapeHtml(e.serverName)}</td>
      <td class="col-action">${e.action}</td>
      <td class="col-result"><span class="badge badge-${e.result}">${e.result}</span></td>
      <td class="${errorCellClass}" title="${escapeHtml(err)}">${escapeHtml(err)}</td>
    </tr>
  `;
  }).join('');

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th class="col-time">Time</th>
          <th class="col-file">File</th>
          <th class="col-server">Server</th>
          <th class="col-action">Action</th>
          <th class="col-result">Result</th>
          <th class="col-error">Error</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Click-to-expand: errors are truncated by default; clicking a populated
  // error cell toggles an `expanded` class that lets the full text wrap.
  container.querySelectorAll('.col-error.has-content').forEach(cell => {
    cell.addEventListener('click', () => cell.classList.toggle('expanded'));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendFilter() {
  const serverId = document.getElementById('filter-server')?.value || undefined;
  const result = document.getElementById('filter-result')?.value || undefined;
  const search = document.getElementById('filter-search')?.value || undefined;
  vscode.postMessage({ command: 'filter', serverId, result, search });
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortPath(fullPath) {
  if (!fullPath) return '';
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : fullPath;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
