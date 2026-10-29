/* =====================================================================
   SIDECAR — pandora-dee offloads heavy, persistent, or missing work to jade-py.
   Config: S.sidecar { enabled, url, token, mode: 'off'|'assistant'|'full' }
   Transport: HTTP API with Bearer token, reusing jade-py's /v1/* routes.
   The sidecar owns the vault on its host; this body keeps a read cache.
   ===================================================================== */
const SIDECAR_VERSION = '0.1';
const SIDECAR_MODES = ['off', 'assistant', 'full'];
let sidecarState = { ready: false, version: null, error: null, lastPing: 0 };

function sidecarDefault() {
  return { enabled: false, url: 'http://127.0.0.1:8760', token: '', mode: 'assistant' };
}
function sidecarCfg() {
  S.sidecar ||= sidecarDefault();
  if (!SIDECAR_MODES.includes(S.sidecar.mode)) S.sidecar.mode = 'assistant';
  return S.sidecar;
}
function sidecarGenToken() {
  const b = new Uint8Array(18); (globalThis.crypto || window.crypto).getRandomValues(b);
  return 'jv_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
function sidecarOn() { const c = sidecarCfg(); return !!c.enabled && !!c.url && !!c.token; }

async function sidecarCall(method, path, body = null, timeout = 30000) {
  const c = sidecarCfg();
  if (!c.url || !c.token) throw new Error('sidecar not configured');
  const url = new URL(path, c.url.replace(/\/$/, '') + '/');
  const init = { method, headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' } };
  if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('sidecar timeout')), timeout);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`sidecar ${r.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(t); }
}

async function sidecarPing() {
  if (!sidecarOn()) { sidecarState = { ready: false, version: null, error: null, lastPing: 0 }; return sidecarState; }
  try {
    const j = await sidecarCall('GET', '/v1/status', null, 5000);
    sidecarState = { ready: true, version: j?.version || j?.app || null, error: null, lastPing: Date.now() };
  } catch (e) { sidecarState = { ready: false, version: null, error: String(e.message || e), lastPing: Date.now() }; }
  return sidecarState;
}

/* ---------- vault proxy: single source of truth lives on the sidecar ---------- */
const sidecarVault = {
  async list(path = '/') {
    return await sidecarCall('GET', `/v1/vault/list?path=${encodeURIComponent(path)}`, null, 10000);
  },
  async file(path) {
    const j = await sidecarCall('GET', `/v1/vault/file?path=${encodeURIComponent(path)}`, null, 10000);
    return j?.text ?? j?.content ?? null;
  },
  async raw(path) {
    const j = await sidecarCall('GET', `/v1/vault/raw?path=${encodeURIComponent(path)}`, null, 10000);
    return j?.data ?? null; // base64 or bytes, decoded by caller
  },
  async write(path, content) {
    return await sidecarCall('POST', '/v1/vault/write', { path, content }, 10000);
  },
  async search(query, limit = 20) {
    return await sidecarCall('GET', `/v1/vault/search?query=${encodeURIComponent(query)}&limit=${limit}`, null, 15000);
  },
};

/* ---------- thin adapter: when sidecar.mode is assistant/full, route calls ---------- */
function sidecarCan(tool) {
  if (!sidecarOn() || sidecarState.ready !== true) return false;
  const c = sidecarCfg();
  if (c.mode === 'full') return true;
  if (c.mode !== 'assistant') return false;
  // assistant mode offloads tools the browser body cannot do well
  const offload = new Set(['vector', 'discord', 'ssh', 'browser', 'schedule', 'ritual', 'flow']);
  for (const p of ['mcp__']) if (tool.startsWith(p)) return true;
  return offload.has(tool);
}

async function sidecarTool(name, args) {
  return await sidecarCall('POST', `/v1/tools/${encodeURIComponent(name)}`, args, 120000);
}

async function sidecarChat(message, opts = {}) {
  return await sidecarCall('POST', '/v1/chat', { message, ...opts }, opts.wait === false ? 10000 : 300000);
}

/* ---------- settings UI ---------- */
function renderSidecarSettings() {
  const c = sidecarCfg();
  $('#sSidecarOn').checked = !!c.enabled;
  $('#sSidecarUrl').value = c.url || '';
  $('#sSidecarToken').value = c.token || '';
  $('#sSidecarMode').value = c.mode || 'assistant';
  $('#sidecarStatus').innerHTML = sidecarStatusHtml();
}
function sidecarStatusHtml() {
  if (!sidecarOn()) return '<span class="dot"></span>Sidecar is off.';
  if (sidecarState.ready) return `<span class="dot ok"></span>Connected${sidecarState.version ? ' · ' + esc(sidecarState.version) : ''}.`;
  if (sidecarState.error) return `<span class="dot bad"></span>${esc(sidecarState.error)}`;
  return '<span class="dot busy"></span>Pinging…';
}
function sidecarReadFields() {
  const c = sidecarCfg();
  c.enabled = $('#sSidecarOn').checked;
  c.url = ($('#sSidecarUrl').value || '').trim();
  c.token = $('#sSidecarToken').value.trim();
  c.mode = SIDECAR_MODES.includes($('#sSidecarMode').value) ? $('#sSidecarMode').value : 'assistant';
  return { sidecar: c };
}
$('#btnSidecarToken').onclick = () => { $('#sSidecarToken').value = sidecarGenToken(); };
$('#btnSidecarCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#sSidecarToken').value); toast('Token copied'); } catch { $('#sSidecarToken').select(); toast('Select and copy the token', 'err'); } };
$('#btnSidecarPing').onclick = async () => { await sidecarPing(); renderSidecarSettings(); };

// ping when settings open, and when enabled changes
let sidecarPingT = 0;
function sidecarTick() {
  const c = sidecarCfg();
  if (!c.enabled) return;
  if (Date.now() - sidecarPingT > 60000) { sidecarPingT = Date.now(); sidecarPing().then(() => { try { renderSidecarSettings(); } catch {} }); }
}
setInterval(sidecarTick, 30000);
