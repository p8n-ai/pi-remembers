/**
 * Dashboard HTML generator — self-contained HTML/CSS/JS for the stats dashboard.
 * No external dependencies or CDN links.
 */

export function getDashboardHtml(port: number): string {
	const API = `http://127.0.0.1:${port}`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🧠 Pi Remembers — Pipeline Observatory</title>
<style>
:root {
  --bg: #0d1117; --bg-card: #161b22; --bg-hover: #1c2128; --bg-input: #0d1117;
  --border: #30363d; --border-light: #21262d;
  --text: #e6edf3; --text-dim: #8b949e; --text-muted: #484f58;
  --accent: #58a6ff; --accent-hover: #79c0ff;
  --success: #3fb950; --error: #f85149; --warning: #d29922; --info: #58a6ff;
  --badge-remember: #238636; --badge-recall: #1f6feb; --badge-search: #8957e5;
  --badge-hook: #d29922; --badge-manifest: #6e7681; --badge-session: #484f58;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --radius: 6px; --transition: 150ms ease;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--font-sans); background: var(--bg); color: var(--text); line-height: 1.5; }
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); }
button { cursor: pointer; font-family: var(--font-sans); }

/* Layout */
.header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--border); background: var(--bg-card); }
.header h1 { font-size: 18px; font-weight: 600; }
.header-actions { display: flex; align-items: center; gap: 12px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); display: inline-block; margin-right: 6px; }
.btn { padding: 6px 14px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); color: var(--text); font-size: 13px; transition: background var(--transition); }
.btn:hover { background: var(--bg-hover); }
.btn-danger { border-color: var(--error); color: var(--error); }
.btn-danger:hover { background: rgba(248,81,73,0.1); }
.btn-active { background: var(--accent); color: #fff; border-color: var(--accent); }

/* Tabs */
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); background: var(--bg-card); padding: 0 24px; }
.tab { padding: 10px 20px; font-size: 14px; color: var(--text-dim); cursor: pointer; border-bottom: 2px solid transparent; transition: all var(--transition); }
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-content { display: none; padding: 24px; }
.tab-content.active { display: block; }

/* Cards */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.card-label { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.card-value { font-size: 28px; font-weight: 700; font-family: var(--font-mono); }
.card-sub { font-size: 12px; color: var(--text-dim); margin-top: 4px; }

/* Table */
.filters { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.filters select, .filters input { padding: 6px 10px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text); font-size: 13px; font-family: var(--font-sans); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
tbody tr { border-bottom: 1px solid var(--border-light); cursor: pointer; transition: background var(--transition); }
tbody tr:hover { background: var(--bg-hover); }
tbody td { padding: 10px 12px; vertical-align: top; }

/* Badges */
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
.badge-remember { background: var(--badge-remember); color: #fff; }
.badge-recall { background: var(--badge-recall); color: #fff; }
.badge-search { background: var(--badge-search); color: #fff; }
.badge-auto_recall { background: var(--badge-hook); color: #000; }
.badge-compaction_ingest { background: var(--badge-hook); color: #000; }
.badge-manifest_refresh, .badge-manifest_discover { background: var(--badge-manifest); color: #fff; }
.badge-list, .badge-list_projects, .badge-session_start, .badge-instance_ensure { background: var(--badge-session); color: #fff; }
.badge-success { background: rgba(63,185,80,0.15); color: var(--success); }
.badge-error { background: rgba(248,81,73,0.15); color: var(--error); }
.badge-skipped { background: rgba(139,148,158,0.15); color: var(--text-dim); }
.badge-pending { background: rgba(210,153,34,0.15); color: var(--warning); }

/* Pipeline detail */
.pipeline-detail { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-top: 12px; }
.pipeline-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.pipeline-steps { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
.step-box { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; min-width: 140px; max-width: 280px; cursor: pointer; transition: all var(--transition); position: relative; }
.step-box:hover { border-color: var(--accent); }
.step-box.expanded { border-color: var(--accent); max-width: 100%; width: 100%; }
.step-box.error-step { border-color: var(--error); }
.step-box.skipped-step { opacity: 0.5; }
.step-name { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
.step-duration { font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }
.step-badge-slowest { display: inline-block; font-size: 10px; background: rgba(210,153,34,0.2); color: var(--warning); padding: 1px 6px; border-radius: 8px; margin-left: 6px; }
.step-badge-error { display: inline-block; font-size: 10px; background: rgba(248,81,73,0.2); color: var(--error); padding: 1px 6px; border-radius: 8px; margin-left: 6px; }
.step-arrow { color: var(--text-muted); font-size: 18px; line-height: 40px; user-select: none; }
.step-detail { margin-top: 10px; display: none; }
.step-box.expanded .step-detail { display: block; }
.json-viewer { background: var(--bg); border: 1px solid var(--border-light); border-radius: var(--radius); padding: 10px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; margin-top: 6px; color: var(--text-dim); }
.step-section-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.3px; margin-top: 8px; margin-bottom: 2px; }
.error-box { background: rgba(248,81,73,0.1); border: 1px solid var(--error); border-radius: var(--radius); padding: 8px 12px; color: var(--error); font-size: 12px; margin-top: 6px; }
.duration-bar { height: 3px; background: var(--accent); border-radius: 2px; margin-top: 6px; transition: width var(--transition); }

/* Pagination */
.pagination { display: flex; align-items: center; gap: 12px; margin-top: 16px; justify-content: center; }
.pagination .page-info { font-size: 13px; color: var(--text-dim); }

/* Memory store */
.mem-section { margin-bottom: 24px; }
.mem-section h3 { font-size: 15px; margin-bottom: 12px; }
.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Config */
.config-section { margin-bottom: 20px; }
.config-section h3 { font-size: 14px; color: var(--text-dim); margin-bottom: 8px; border-bottom: 1px solid var(--border-light); padding-bottom: 4px; }
.config-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
.config-key { color: var(--text-dim); }
.config-val { font-family: var(--font-mono); color: var(--text); }
.feat-on { color: var(--success); }
.feat-off { color: var(--error); }

/* Errors list */
.error-list { list-style: none; }
.error-list li { padding: 8px 12px; border-left: 3px solid var(--error); background: var(--bg-card); margin-bottom: 8px; border-radius: 0 var(--radius) var(--radius) 0; font-size: 13px; cursor: pointer; }
.error-list li:hover { background: var(--bg-hover); }
.error-time { color: var(--text-dim); font-size: 11px; font-family: var(--font-mono); }

/* Timeline chart */
.timeline { display: flex; align-items: flex-end; gap: 2px; height: 80px; margin-bottom: 24px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; }
.timeline-bar { flex: 1; min-width: 4px; border-radius: 2px 2px 0 0; background: var(--accent); transition: height var(--transition); position: relative; }
.timeline-bar:hover { opacity: 0.8; }
.timeline-bar[title]:hover::after { content: attr(title); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--bg-card); border: 1px solid var(--border); padding: 4px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap; z-index: 10; }

/* Responsive */
@media (max-width: 768px) {
  .header { flex-direction: column; gap: 12px; }
  .cards { grid-template-columns: repeat(2, 1fr); }
  .filters { flex-direction: column; }
  .pipeline-steps { flex-direction: column; }
  .step-arrow { display: none; }
}

.shutdown-msg { text-align: center; padding: 60px 20px; font-size: 18px; color: var(--text-dim); }
</style>
</head>
<body>

<div class="header">
  <h1><span class="status-dot" id="statusDot"></span>Pi Remembers — Pipeline Observatory</h1>
  <div class="header-actions">
    <select id="projectFilter" onchange="onProjectChange()" style="padding:6px 10px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-input);color:var(--text);font-size:13px;font-family:var(--font-sans);min-width:160px;">
      <option value="">All Projects</option>
    </select>
    <button class="btn" onclick="refresh()" id="refreshBtn">↻ Refresh</button>
    <button class="btn" id="liveBtn" onclick="toggleLive()">◉ Live: OFF</button>
    <button class="btn btn-danger" onclick="shutdown()">⏻ Stop Server</button>
  </div>
</div>

<div class="tabs">
  <div class="tab active" data-tab="overview">Overview</div>
  <div class="tab" data-tab="operations">Operations</div>
  <div class="tab" data-tab="memstore">Memory Store</div>
  <div class="tab" data-tab="config">Config</div>
</div>

<!-- Overview Tab -->
<div class="tab-content active" id="tab-overview">
  <div class="cards" id="summaryCards"></div>
  <h3 style="font-size:14px; color:var(--text-dim); margin-bottom:8px;">Operations (last 24h)</h3>
  <div class="timeline" id="timeline"></div>
  <h3 style="font-size:14px; color:var(--text-dim); margin-bottom:8px;">Recent Errors</h3>
  <ul class="error-list" id="errorList"><li style="color:var(--text-dim)">Loading...</li></ul>
</div>

<!-- Operations Tab -->
<div class="tab-content" id="tab-operations">
  <div class="filters">
    <select id="filterType" onchange="loadOperations()">
      <option value="">All Types</option>
      <option value="remember">Remember</option>
      <option value="recall">Recall</option>
      <option value="search">Search</option>
      <option value="auto_recall">Auto-Recall</option>
      <option value="compaction_ingest">Compaction</option>
      <option value="manifest_refresh">Manifest Refresh</option>
      <option value="manifest_discover">Manifest Discover</option>
      <option value="list">List</option>
      <option value="list_projects">List Projects</option>
      <option value="session_start">Session Start</option>
      <option value="instance_ensure">Instance Ensure</option>
    </select>
    <select id="filterStatus" onchange="loadOperations()">
      <option value="">All Status</option>
      <option value="success">Success</option>
      <option value="error">Error</option>
      <option value="skipped">Skipped</option>
      <option value="pending">Pending</option>
    </select>
    <input type="text" id="filterSearch" placeholder="Search query..." oninput="loadOperations()" style="width:200px;">
  </div>
  <table>
    <thead>
      <tr><th>Time</th><th>Type</th><th>Project</th><th>Scope</th><th>Query</th><th>Status</th><th>Duration</th><th>Steps</th></tr>
    </thead>
    <tbody id="opsTable"></tbody>
  </table>
  <div id="pipelineContainer"></div>
  <div class="pagination" id="pagination"></div>
</div>

<!-- Memory Store Tab -->
<div class="tab-content" id="tab-memstore">
  <div id="memContent"><span class="spinner"></span> Loading memories...</div>
</div>

<!-- Config Tab -->
<div class="tab-content" id="tab-config">
  <div id="configContent"><span class="spinner"></span> Loading config...</div>
</div>

<script>
const API = '${API}';
let currentPage = 0;
const PAGE_SIZE = 50;
let liveInterval = null;
let currentOps = [];
let selectedProject = ''; // '' = all projects

// Project filter
async function loadProjects() {
  const data = await api('/api/projects');
  if (!data || !data.projects) return;
  const sel = document.getElementById('projectFilter');
  // Keep "All Projects" + add "Global (no project)"
  sel.innerHTML = '<option value="">All Projects</option><option value="__global__">Global (no project)</option>';
  for (const p of data.projects) {
    const opt = document.createElement('option');
    opt.value = p.project_id;
    opt.textContent = p.project_name + ' (' + p.op_count + ' ops)';
    sel.appendChild(opt);
  }
}

function onProjectChange() {
  selectedProject = document.getElementById('projectFilter').value;
  currentPage = 0;
  refresh();
}

function projectParam() {
  return selectedProject ? '&project=' + encodeURIComponent(selectedProject) : '';
}

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'memstore') loadMemories();
    if (tab.dataset.tab === 'config') loadConfig();
  });
});

// Live toggle
function toggleLive() {
  const btn = document.getElementById('liveBtn');
  if (liveInterval) {
    clearInterval(liveInterval);
    liveInterval = null;
    btn.textContent = '◉ Live: OFF';
    btn.classList.remove('btn-active');
    localStorage.setItem('pi-stats-live', 'off');
  } else {
    liveInterval = setInterval(refresh, 5000);
    btn.textContent = '◉ Live: ON';
    btn.classList.add('btn-active');
    localStorage.setItem('pi-stats-live', 'on');
  }
}

// Restore live state
if (localStorage.getItem('pi-stats-live') === 'on') {
  setTimeout(toggleLive, 100);
}

async function api(path) {
  try {
    const r = await fetch(API + path);
    return await r.json();
  } catch { return null; }
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function typeBadge(type) {
  return '<span class="badge badge-' + type + '">' + type.replace(/_/g, ' ') + '</span>';
}

function statusBadge(status) {
  return '<span class="badge badge-' + status + '">' + (status === 'success' ? '✅' : status === 'error' ? '❌' : status === 'skipped' ? '⏭' : '⏳') + ' ' + status + '</span>';
}

function truncate(s, n) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Overview
async function loadSummary() {
  const s = await api('/api/summary?' + projectParam().replace(/^&/, ''));
  if (!s) return;
  const cards = document.getElementById('summaryCards');
  const successRate = s.totalOps > 0 ? Math.round(((s.byStatus.success || 0) / s.totalOps) * 100) : 0;
  const types = Object.entries(s.byType).map(([k,v]) => k.replace(/_/g,' ') + ': ' + v).join(', ');

  cards.innerHTML = [
    card('Total Ops', s.totalOps, '7-day window'),
    card('Success Rate', successRate + '%', (s.byStatus.error || 0) + ' errors'),
    card('Errors (24h)', s.errorsLast24h, ''),
    card('By Type', '', types),
    card('Avg Recall', fmtDuration(s.avgDurationByType.recall), ''),
    card('Last Activity', '', s.timeRange.latest ? fmtTime(s.timeRange.latest) : 'none'),
  ].join('');
}

function card(label, value, sub) {
  return '<div class="card"><div class="card-label">' + label + '</div><div class="card-value">' + value + '</div><div class="card-sub">' + sub + '</div></div>';
}

async function loadTimeline() {
  const ops = await api('/api/operations?limit=200' + projectParam());
  if (!ops) return;
  const el = document.getElementById('timeline');
  const now = Date.now();
  const hours = new Array(24).fill(0);
  for (const op of ops.operations) {
    const age = (now - new Date(op.timestamp).getTime()) / 3600000;
    if (age < 24) hours[Math.floor(age)]++;
  }
  const max = Math.max(...hours, 1);
  el.innerHTML = hours.map((c, i) => {
    const h = Math.max(2, (c / max) * 56);
    const label = (23 - i) + 'h ago: ' + c + ' ops';
    return '<div class="timeline-bar" style="height:' + h + 'px" title="' + label + '"></div>';
  }).reverse().join('');
}

async function loadErrors() {
  const ops = await api('/api/operations?status=error&limit=10' + projectParam());
  if (!ops || !ops.operations.length) {
    document.getElementById('errorList').innerHTML = '<li style="color:var(--text-dim)">No recent errors 🎉</li>';
    return;
  }
  document.getElementById('errorList').innerHTML = ops.operations.map(op =>
    '<li onclick="showOperation(\\'' + op.id + '\\')">' +
    '<span class="error-time">' + fmtTime(op.timestamp) + '</span> ' +
    typeBadge(op.type) + ' ' + truncate(op.error || op.query, 80) +
    '</li>'
  ).join('');
}

// Operations
async function loadOperations() {
  const type = document.getElementById('filterType').value;
  const status = document.getElementById('filterStatus').value;
  const search = document.getElementById('filterSearch').value.toLowerCase();
  let url = '/api/operations?limit=' + PAGE_SIZE + '&offset=' + (currentPage * PAGE_SIZE) + projectParam();
  if (type) url += '&type=' + type;
  if (status) url += '&status=' + status;
  const data = await api(url);
  if (!data) return;

  let ops = data.operations;
  if (search) ops = ops.filter(o => (o.query || '').toLowerCase().includes(search));
  currentOps = ops;

  const tbody = document.getElementById('opsTable');
  tbody.innerHTML = ops.map((op, i) =>
    '<tr onclick="togglePipeline(' + i + ',\\'' + op.id + '\\')" id="op-row-' + i + '">' +
    '<td>' + fmtTime(op.timestamp) + '</td>' +
    '<td>' + typeBadge(op.type) + '</td>' +
    '<td style="font-size:12px;color:var(--text-dim)">' + (op.project_name || '<em>global</em>') + '</td>' +
    '<td>' + (op.scope || '—') + '</td>' +
    '<td title="' + (op.query || '').replace(/"/g, '&quot;') + '">' + truncate(op.query, 50) + '</td>' +
    '<td>' + statusBadge(op.status) + '</td>' +
    '<td style="font-family:var(--font-mono)">' + fmtDuration(op.duration_ms) + '</td>' +
    '<td>—</td>' +
    '</tr>'
  ).join('');

  // Pagination
  const total = data.total;
  const pages = Math.ceil(total / PAGE_SIZE);
  document.getElementById('pagination').innerHTML =
    '<button class="btn" onclick="prevPage()" ' + (currentPage === 0 ? 'disabled' : '') + '>← Prev</button>' +
    '<span class="page-info">Page ' + (currentPage + 1) + ' of ' + Math.max(pages, 1) + ' (' + total + ' total)</span>' +
    '<button class="btn" onclick="nextPage()" ' + (currentPage >= pages - 1 ? 'disabled' : '') + '>Next →</button>';
}

function prevPage() { if (currentPage > 0) { currentPage--; loadOperations(); } }
function nextPage() { currentPage++; loadOperations(); }

let expandedPipeline = -1;

async function togglePipeline(idx, id) {
  const container = document.getElementById('pipelineContainer');
  if (expandedPipeline === idx) {
    container.innerHTML = '';
    expandedPipeline = -1;
    return;
  }
  expandedPipeline = idx;
  const op = await api('/api/operations/' + id);
  if (!op) return;
  container.innerHTML = renderPipeline(op);
}

async function showOperation(id) {
  // Switch to operations tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="operations"]').classList.add('active');
  document.getElementById('tab-operations').classList.add('active');

  const container = document.getElementById('pipelineContainer');
  const op = await api('/api/operations/' + id);
  if (!op) return;
  container.innerHTML = renderPipeline(op);
}

function renderPipeline(op) {
  const steps = op.steps || [];
  const maxDur = Math.max(...steps.map(s => s.duration_ms || 0), 1);
  const totalDur = op.duration_ms || 1;
  const slowestIdx = steps.reduce((best, s, i) => (s.duration_ms || 0) > (steps[best]?.duration_ms || 0) ? i : best, 0);

  let html = '<div class="pipeline-detail">';
  html += '<div class="pipeline-header">' + typeBadge(op.type) + ' <strong>' + truncate(op.query, 60) + '</strong> ';
  html += '<span style="color:var(--text-dim)">' + fmtTime(op.timestamp) + ' — ' + fmtDuration(op.duration_ms) + '</span> ';
  html += statusBadge(op.status);
  if (op.error) html += '<div class="error-box" style="margin-top:8px">' + op.error + '</div>';
  html += '</div>';

  html += '<div class="pipeline-steps">';
  steps.forEach((step, i) => {
    if (i > 0) html += '<span class="step-arrow">→</span>';
    const isSlowest = i === slowestIdx && steps.length > 1 && (step.duration_ms || 0) > 0;
    const isError = !!step.error;
    const isSkipped = (tryParse(step.metadata)?.skippedReason || tryParse(step.input_data)?.enabled === false);
    let cls = 'step-box';
    if (isError) cls += ' error-step';
    if (isSkipped) cls += ' skipped-step';

    html += '<div class="' + cls + '" onclick="this.classList.toggle(\\'expanded\\')" id="step-' + op.id + '-' + i + '">';
    html += '<div class="step-name">' + (step.step_order) + '. ' + step.step_name.replace(/_/g, ' ');
    if (isSlowest) html += '<span class="step-badge-slowest">⚠ SLOWEST</span>';
    if (isError) html += '<span class="step-badge-error">❌ ERROR</span>';
    html += '</div>';
    html += '<div class="step-duration">' + fmtDuration(step.duration_ms) + '</div>';
    if (step.duration_ms && totalDur) {
      const pct = Math.max(2, (step.duration_ms / totalDur) * 100);
      html += '<div class="duration-bar" style="width:' + pct + '%"></div>';
    }

    // Expandable detail
    html += '<div class="step-detail">';
    if (step.input_data) {
      html += '<div class="step-section-label">Input</div>';
      html += '<div class="json-viewer">' + prettyJson(step.input_data) + '</div>';
    }
    if (step.output_data) {
      html += '<div class="step-section-label">Output</div>';
      html += '<div class="json-viewer">' + prettyJson(step.output_data) + '</div>';
    }
    if (step.metadata) {
      html += '<div class="step-section-label">Metadata</div>';
      html += '<div class="json-viewer">' + prettyJson(step.metadata) + '</div>';
    }
    if (step.error) {
      html += '<div class="error-box">' + escapeHtml(step.error) + '</div>';
    }
    html += '</div>'; // step-detail
    html += '</div>'; // step-box
  });
  html += '</div>'; // pipeline-steps
  html += '</div>'; // pipeline-detail
  return html;
}

function tryParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function prettyJson(s) {
  if (!s) return '';
  try {
    const obj = typeof s === 'string' ? JSON.parse(s) : s;
    return escapeHtml(JSON.stringify(obj, null, 2));
  } catch { return escapeHtml(String(s)); }
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Memory Store
async function loadMemories() {
  const el = document.getElementById('memContent');
  el.innerHTML = '<span class="spinner"></span> Loading memories from Cloudflare...';
  const data = await api('/api/memories');
  if (!data) { el.innerHTML = '<p style="color:var(--error)">Failed to load memories</p>'; return; }
  let html = '';
  html += memSection('Project Memories', data.projectInstance, data.project, data.projectCount, data.projectError);
  html += memSection('Global Memories', data.globalInstance, data.global, data.globalCount, data.globalError);
  el.innerHTML = html;
}

function memSection(title, instance, items, count, error) {
  let html = '<div class="mem-section"><h3>' + title + ' <span style="color:var(--text-dim);font-size:12px">(' + (instance || '?') + ')</span></h3>';
  if (error) { html += '<p style="color:var(--error)">' + error + '</p></div>'; return html; }
  if (!items || items.length === 0) { html += '<p style="color:var(--text-dim)">No items</p></div>'; return html; }
  html += '<p style="color:var(--text-dim);font-size:13px;margin-bottom:8px">' + (count || items.length) + ' item(s)</p>';
  html += '<table><thead><tr><th>Key</th><th>Status</th><th>ID</th></tr></thead><tbody>';
  for (const item of items) {
    html += '<tr><td>' + escapeHtml(item.key || '—') + '</td><td>' + (item.status || '—') + '</td><td style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">' + (item.id || '—') + '</td></tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

// Config
async function loadConfig() {
  const el = document.getElementById('configContent');
  const data = await api('/api/config');
  if (!data || data.error) { el.innerHTML = '<p style="color:var(--error)">' + (data?.error || 'Failed to load') + '</p>'; return; }
  let html = '';

  html += configSection('Identity', [
    ['Project ID', data.projectId || '—'],
    ['Project Name', data.projectName],
    ['Project Root', data.projectRoot],
    ['Aliases', (data.projectAliases || []).join(', ') || '—'],
    ['Related', (data.relatedProjects || []).join(', ') || '—'],
    ['Workspace', data.workspace || '—'],
  ]);

  html += configSection('Instances', [
    ['Namespace', data.namespace],
    ['Project Memory', data.projectMemoryInstance],
    ['Global Memory', data.globalMemoryInstance],
    ['Search', data.searchInstance],
    ['Account', data.accountId],
    ['API Token', data.apiToken],
  ]);

  html += configSection('Hooks', [
    ['autoRecall', featBadge(data.hooks.autoRecall)],
    ['autoIngest', featBadge(data.hooks.autoIngest)],
    ['showStatus', featBadge(data.hooks.showStatus)],
  ]);

  const f = data.features;
  html += configSection('Features', [
    ['Identity: autoCreateMarker', featBadge(f.identity.autoCreateMarker)],
    ['Identity: walkUp', featBadge(f.identity.walkUp)],
    ['Recall: includeRelated', featBadge(f.recall.includeRelated)],
    ['Recall: includeDiscovered', featBadge(f.recall.includeDiscovered)],
    ['Manifest: enabled', featBadge(f.manifest.enabled)],
    ['Subagent: enabled', featBadge(f.subagent.enabled)],
    ['Subagent: model', f.subagent.model || 'default'],
    ['Stats: enabled', featBadge(f.stats.enabled)],
  ]);

  el.innerHTML = html;
}

function configSection(title, rows) {
  let html = '<div class="config-section"><h3>' + title + '</h3>';
  for (const [k, v] of rows) {
    html += '<div class="config-row"><span class="config-key">' + k + '</span><span class="config-val">' + v + '</span></div>';
  }
  html += '</div>';
  return html;
}

function featBadge(val) {
  return val ? '<span class="feat-on">✓ enabled</span>' : '<span class="feat-off">○ disabled</span>';
}

// Refresh
async function refresh() {
  loadProjects(); // keep project list fresh
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  if (activeTab === 'overview' || !activeTab) {
    await Promise.all([loadSummary(), loadTimeline(), loadErrors()]);
  } else if (activeTab === 'operations') {
    await loadOperations();
  } else if (activeTab === 'memstore') {
    await loadMemories();
  } else if (activeTab === 'config') {
    await loadConfig();
  }
}

// Shutdown
async function shutdown() {
  await fetch(API + '/api/shutdown', { method: 'POST' });
  document.body.innerHTML = '<div class="shutdown-msg">📊 Dashboard server stopped.<br><br><span style="font-size:14px;color:var(--text-muted)">Close this tab.</span></div>';
  document.getElementById('statusDot')?.style && (document.getElementById('statusDot').style.background = 'var(--error)');
}

// Init
loadProjects();
loadSummary();
loadTimeline();
loadErrors();
loadOperations();
</script>
</body>
</html>`;
}
