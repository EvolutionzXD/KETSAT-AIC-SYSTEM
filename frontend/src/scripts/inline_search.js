// ══════════════════════════════════════════════════════════
// Inline OCR / ASR search over current result set
// + Dynamic FPS from backend  (/api/video-fps)
// Ported & adapted from frontend_aic_reference (TriNguyen0109)
// ══════════════════════════════════════════════════════════

'use strict';

/* ── 1. Tiny utilities ── */
const _norm1 = c => c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
const _norm = s => _norm1(String(s || '')).replace(/\s+/g, ' ').trim();
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function _hl(text, terms) {
  const chars = Array.from(String(text || ''));
  if (!terms || !terms.length) return _esc(text);
  let ns = ''; const map = [];
  chars.forEach((c, i) => { const n = _norm1(c); for (const _ of n) map.push(i); ns += n; });
  const mark = new Array(chars.length).fill(false);
  for (const t of terms) {
    let p = 0;
    while (t && (p = ns.indexOf(t, p)) !== -1) { for (let k = p; k < p + t.length; k++) mark[map[k]] = true; p += t.length; }
  }
  let out = '', open = false;
  chars.forEach((c, i) => {
    if (mark[i] && !open) { out += '<mark>'; open = true; }
    if (!mark[i] && open) { out += '</mark>'; open = false; }
    out += _esc(c);
  });
  return open ? out + '</mark>' : out;
}

function _fmtTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const two = n => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/* ── 2. FPS – load once from /api/video-fps ── */
window.FPS_DATA = null;
let _fpsLoading = null;

function loadFps() {
  if (window.FPS_DATA) return Promise.resolve(window.FPS_DATA);
  if (_fpsLoading) return _fpsLoading;
  _fpsLoading = fetch(`${window.BACKEND_BASE || ''}/api/video-fps`, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(v => {
      if (v && (v.overrides || Number(v.default_fps) > 0)) window.FPS_DATA = v;
      return window.FPS_DATA;
    })
    .catch(() => null)
    .finally(() => { _fpsLoading = null; });
  return _fpsLoading;
}

/** Get FPS for a given video_id. Falls back to 25 if not loaded. */
window.fpsOf = function(videoId) {
  if (!window.FPS_DATA || !videoId) return null;
  const x = Number(window.FPS_DATA.overrides?.[videoId] ?? window.FPS_DATA.default_fps);
  return x > 0 ? x : null;
};
window.fps25 = v => window.fpsOf(v) || 25;

// Kick off FPS loading immediately on page load
loadFps();

/* ── 3. OCR / ASR data cache ── */
const TX = {
  data: new Map(),    // video_id → { ocr: [...], asr: [...] }
  pending: new Map(), // video_id → Promise
  q: '',
  terms: [],
  src: 'all',        // 'all' | 'ocr' | 'asr'
  only: false,       // hide non-matching cards
  show: false,       // show nearest text chip even without query
  gen: 0,
  loading: false,
};

async function _fetchOcr(videoId) {
  try {
    const r = await fetch(`${window.BACKEND_BASE || ''}/api/videos/${encodeURIComponent(videoId)}/ocr`);
    if (!r.ok) return [];
    const list = await r.json();
    const fps = window.fps25(videoId);
    return (Array.isArray(list) ? list : [])
      .filter(x => x && x.text && String(x.text).trim())
      .map(x => ({ src: 'ocr', frame: Number(x.frame_id), t: Number(x.frame_id) / fps, text: String(x.text).trim(), n: _norm(x.text) }));
  } catch { return []; }
}

function _normalizeAsr(payload) {
  let raw = payload;
  if (!Array.isArray(raw) && raw && typeof raw === 'object')
    for (const k of ['segments', 'data', 'results', 'asr']) if (Array.isArray(raw[k])) { raw = raw[k]; break; }
  if (!Array.isArray(raw)) return [];
  const num = (...xs) => { for (const x of xs) { if (x === null || x === undefined || x === '' || typeof x === 'boolean') continue; const n = Number(x); if (Number.isFinite(n) && n >= 0) return n; } return null; };
  return raw.map(s0 => {
    const s = s0 && typeof s0.record === 'object' ? { ...s0.record, ...s0 } : (s0 || {});
    const start = num(s.start, s.start_seconds, s.start_time, s.begin);
    const end = num(s.end, s.end_seconds, s.end_time, s.stop, start);
    const text = [s.text, s.transcript, s.asr, s.caption, s.content].find(x => typeof x === 'string' && x.trim());
    return { src: 'asr', t: start, end: end === null ? start : Math.max(start ?? 0, end), text: text ? text.trim() : '' };
  }).filter(s => s.t !== null && s.text).map(s => ({ ...s, n: _norm(s.text) })).sort((a, b) => a.t - b.t);
}

async function _fetchAsr(videoId) {
  try {
    const r = await fetch(`${window.BACKEND_BASE || ''}/api/videos/${encodeURIComponent(videoId)}/asr`, { cache: 'no-store' });
    if (r.ok) { const segs = _normalizeAsr(await r.json()); if (segs.length) return segs; }
  } catch { /* ignore */ }
  return [];
}

function _txLoad(videoId) {
  if (TX.data.has(videoId)) return Promise.resolve(TX.data.get(videoId));
  if (!TX.pending.has(videoId)) {
    TX.pending.set(videoId, loadFps().then(() => Promise.all([_fetchOcr(videoId), _fetchAsr(videoId)])).then(([ocr, asr]) => {
      const d = { ocr, asr };
      TX.data.set(videoId, d);
      TX.pending.delete(videoId);
      return d;
    }));
  }
  return TX.pending.get(videoId);
}

async function _txEnsureAndApply() {
  const currentResults = window._inlineSearchResults || [];
  const videos = [...new Set(currentResults.map(r => r.video_id))];
  const todo = videos.filter(v => !TX.data.has(v));
  _applyTx();
  if (!todo.length) return;
  const gen = ++TX.gen;
  TX.loading = true;
  let done = 0;
  const badge = document.getElementById('tx-badge');
  const progress = () => {
    if (gen !== TX.gen || !badge) return;
    badge.hidden = false;
    badge.className = 'tx-badge-load';
    badge.textContent = `⏳ Tải OCR/ASR ${done}/${todo.length} video`;
  };
  progress();
  const queue = todo.slice();
  const worker = async () => { while (queue.length) { const v = queue.shift(); await _txLoad(v).catch(() => {}); done++; progress(); if (done % 4 === 0 && gen === TX.gen) _applyTx(); } };
  await Promise.all([worker(), worker(), worker()]);
  if (gen === TX.gen) { TX.loading = false; _applyTx(); }
}

function _txMatch(result) {
  const t0 = result.timestamp_seconds || 0;
  const d = TX.data.get(result.video_id);
  const cands = [];
  if (result.ocr_snippet) cands.push({ src: 'ocr', t: t0, text: result.ocr_snippet, n: _norm(result.ocr_snippet) });
  if (result.audio_segment_text) cands.push({ src: 'asr', t: t0, end: t0, text: result.audio_segment_text, n: _norm(result.audio_segment_text) });
  if (d) cands.push(...d.ocr, ...d.asr);
  let best = null, bd = Infinity;
  for (const c of cands) {
    if (TX.src !== 'all' && c.src !== TX.src) continue;
    if (!TX.terms.some(t => c.n.includes(t))) continue;
    const dist = c.end != null ? (t0 < c.t ? c.t - t0 : t0 > c.end ? t0 - c.end : 0) : Math.abs(c.t - t0);
    if (dist < bd) { bd = dist; best = c; }
  }
  return best;
}

function _txNearest(result) {
  const t0 = result.timestamp_seconds || 0;
  const d = TX.data.get(result.video_id);
  const out = [];
  let ocr = result.ocr_snippet ? { src: 'ocr', t: t0, text: result.ocr_snippet } : null;
  let asr = result.audio_segment_text ? { src: 'asr', t: t0, text: result.audio_segment_text } : null;
  if (d) {
    let bd = 5.01;
    for (const c of d.ocr) { const dd = Math.abs(c.t - t0); if (dd < bd) { bd = dd; ocr = c; } }
    let ba = 3.01;
    for (const c of d.asr) { const dd = t0 < c.t ? c.t - t0 : t0 > c.end ? t0 - c.end : 0; if (dd < ba) { ba = dd; asr = c; } }
  }
  if (TX.src !== 'asr' && ocr) out.push(ocr);
  if (TX.src !== 'ocr' && asr) out.push(asr);
  return out;
}

const _chipHTML = (c, matched) => `<div class="tx-chip${matched ? ' matched' : ''}" data-t="${c.t}" title="[${c.src.toUpperCase()} ${_fmtTime(c.t)}] ${_esc(c.text)}">${c.src === 'ocr' ? '🔤' : '🎙'} <b>${_fmtTime(c.t)}</b> ${matched ? _hl(c.text, TX.terms) : _esc(c.text)}</div>`;

function _applyTx() {
  const active = TX.terms.length > 0;
  let hits = 0; const hitVideos = new Set();
  document.querySelectorAll('.img-dis').forEach((card, i) => {
    const result = (window._inlineSearchResults || [])[i];
    if (!result) return;
    let txBox = card.querySelector('.tx-chips');
    if (!txBox) {
      txBox = document.createElement('div');
      txBox.className = 'tx-chips';
      card.appendChild(txBox);
    }
    let html = '';
    if (active) {
      const m = _txMatch(result);
      card.classList.toggle('tx-hit', !!m);
      card.classList.toggle('tx-hide', !m && TX.only);
      if (m) { hits++; hitVideos.add(result.video_id); html = _chipHTML(m, true); }
    } else {
      card.classList.remove('tx-hit', 'tx-hide');
      if (TX.show) html = _txNearest(result).map(c => _chipHTML(c, false)).join('');
    }
    txBox.innerHTML = html;
    txBox.hidden = !html;
  });

  const bar = document.getElementById('tx-bar');
  if (bar) bar.classList.toggle('tx-active', active);
  const clearBtn = document.getElementById('tx-clear-btn');
  if (clearBtn) clearBtn.hidden = !active;
  const badge = document.getElementById('tx-badge');
  if (TX.loading || !badge) return;
  badge.hidden = !active;
  badge.className = 'tx-badge';
  if (active) badge.textContent = `🌟 ${hits}/${(window._inlineSearchResults||[]).length} frame · ${hitVideos.size} video khớp`;
}

function _onTxInput() {
  const input = document.getElementById('tx-query');
  TX.q = input ? input.value : '';
  TX.terms = TX.q.split(',').map(_norm).filter(Boolean);
  TX.src = (document.getElementById('tx-src')?.value) || 'all';
  TX.only = document.getElementById('tx-only')?.checked || false;
  TX.show = document.getElementById('tx-show')?.checked || false;
  const results = window._inlineSearchResults || [];
  if ((TX.terms.length || TX.show) && results.length) _txEnsureAndApply();
  else _applyTx();
}

/** Call this after each search to register results for inline OCR/ASR search */
window.setInlineSearchResults = function(results) {
  window._inlineSearchResults = Array.isArray(results) ? results : [];
  // Pre-load OCR/ASR if a search is active
  if (TX.terms.length || TX.show) _txEnsureAndApply();
};

/* ── 4. Bind toolbar UI ── */
function _bindToolbar() {
  ['tx-query', 'tx-src', 'tx-only', 'tx-show'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(el.tagName === 'INPUT' && el.type === 'checkbox' ? 'change' : 'input', _onTxInput);
  });
  const clearBtn = document.getElementById('tx-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    const inp = document.getElementById('tx-query');
    if (inp) inp.value = '';
    _onTxInput();
  });
}

// Run once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _bindToolbar);
} else {
  _bindToolbar();
}

/* ── 5. CSS injection for tx chips ── */
(function injectTxCss() {
  if (document.getElementById('inline-search-css')) return;
  const style = document.createElement('style');
  style.id = 'inline-search-css';
  style.textContent = `
    #tx-bar {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      padding: 4px 8px; background: rgba(255,255,255,0.04); border-radius: 6px;
      margin-bottom: 4px; transition: box-shadow 0.2s;
    }
    #tx-bar.tx-active { box-shadow: inset 0 0 0 1px rgba(251,191,36,0.7); }
    #tx-query {
      flex: 1; min-width: 180px; background: transparent; border: none;
      color: #e8f2fc; font-size: 0.82rem; padding: 3px 6px; outline: none;
    }
    #tx-query::placeholder { color: rgba(207,224,243,0.5); }
    #tx-src { background: #132844; border: 1px solid rgba(147,197,253,0.16); color: #e8f2fc; border-radius: 4px; font-size: 0.72rem; padding: 2px 4px; cursor: pointer; }
    .tx-chk { display: inline-flex; align-items: center; gap: 3px; font-size: 0.72rem; color: #cfe0f3; cursor: pointer; white-space: nowrap; }
    .tx-chk input { accent-color: #1e88e5; }
    #tx-badge { font-size: 0.7rem; font-weight: 800; color: #1a1305; background: #fbbf24; padding: 2px 8px; border-radius: 99px; white-space: nowrap; }
    .tx-badge-load { background: #1b375c !important; color: #cfe0f3 !important; }
    #tx-clear-btn { background: transparent; border: none; color: rgba(207,224,243,0.6); cursor: pointer; font-size: 0.85rem; padding: 0 4px; }
    #tx-clear-btn:hover { color: #fff; }
    .tx-chips { display: flex; flex-direction: column; gap: 1px; padding: 2px; }
    .tx-chip {
      font-size: 0.66rem; line-height: 1.25; padding: 2px 4px; border-radius: 3px;
      color: #cfe0f3; display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow: hidden; cursor: pointer;
    }
    .tx-chip:hover { text-decoration: underline; }
    .tx-chip.matched { background: #fbbf24; color: #1a1305; font-weight: 700; }
    .tx-chip mark { background: rgba(30,136,229,0.85); color: #fff; border-radius: 2px; padding: 0 1px; }
    .tx-chip.matched mark { background: #1a1305; color: #fde68a; }
    .img-dis.tx-hit { outline: 2px solid #fbbf24 !important; outline-offset: -2px; }
    .img-dis.tx-hide { display: none !important; }
  `;
  document.head.appendChild(style);
})();
