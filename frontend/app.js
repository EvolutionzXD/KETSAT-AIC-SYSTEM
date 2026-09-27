/* AIC 2026 Final Frontend — app.js
 * Giữ toàn bộ chức năng đang chạy của frontend aic_backend_RRF_exp
 * (KIS / Q&A / TRAKE, Standard · Multi-mode · Lock-video, lọc video đã chọn,
 * frame strip, video viewer, danh sách nộp, CSV/SOLOAI, DRES, team sync, TRAKE workspace)
 * với giao diện theo frontend-vanilla, cộng thêm: hover để phát video và
 * tìm OCR/ASR trên K kết quả.  Không framework, không build.
 */
'use strict';

/* ════════════════════ 1. Tiện ích ════════════════════ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const enc = encodeURIComponent;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  json(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
};
const MARKS = /[̀-ͯ]/g;
const norm1 = c => c.normalize('NFD').replace(MARKS, '').replace(/[đĐ]/g, 'd').toLowerCase();
const norm = s => norm1(String(s || '')).replace(/\s+/g, ' ').trim();
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function fmtTime(sec, tenth = false) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const two = n => String(n).padStart(2, '0');
  const base = h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
  return tenth ? `${base}.${Math.floor((sec % 1) * 10)}` : base;
}

// Tô sáng các cụm khớp, không phân biệt dấu/hoa thường.
function hl(text, terms) {
  const chars = Array.from(String(text || ''));
  if (!terms || !terms.length) return esc(text);
  let ns = ''; const map = [];
  chars.forEach((c, i) => { const n = norm1(c); for (const _ of n) map.push(i); ns += n; });
  const mark = new Array(chars.length).fill(false);
  for (const t of terms) {
    let p = 0;
    while (t && (p = ns.indexOf(t, p)) !== -1) { for (let k = p; k < p + t.length; k++) mark[map[k]] = true; p += t.length; }
  }
  let out = '', open = false;
  chars.forEach((c, i) => {
    if (mark[i] && !open) { out += '<mark>'; open = true; }
    if (!mark[i] && open) { out += '</mark>'; open = false; }
    out += esc(c);
  });
  return open ? out + '</mark>' : out;
}

function toast(msg, type = 'info', ms = 2800) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(60%)'; setTimeout(() => el.remove(), 260); }, ms);
}

/* ════════════════════ 2. Cấu hình & API ════════════════════ */
// Mặc định gọi backend qua chính địa chỉ của trang (server.py / nginx chuyển tiếp /api, /ws).
// Tham số URL ?backend= ?media= ?dres= vẫn dùng được. Dùng key localStorage riêng để
// không vô tình lấy lại địa chỉ cũ mà frontend trước lưu trên cùng localhost:8082.
const qs = new URLSearchParams(location.search);
function cfgValue(param, key, def) {
  const v = qs.get(param);
  if (v) { store.set(key, v); return v; }
  return store.get(key) || def;
}
const trimSlash = u => String(u || '').trim().replace(/\/+$/, '');
const normDresUrl = u => { let s = String(u || '').trim(); if (!s) return ''; if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) s = (/^(localhost|\d+\.\d+\.\d+\.\d+)(:|\/|$)/.test(s) ? 'http://' : 'https://') + s; return s.replace(/\/+$/, ''); };
const HTTP_PAGE = /^https?:$/.test(location.protocol);
const CFG = {
  backend: trimSlash(cfgValue('backend', 'aicFinalBackend', HTTP_PAGE ? location.origin : 'http://localhost:8602')),
  // Video/ảnh luôn lấy qua server.py (máy trước, thiếu thì backend). ?media= chỉ để gỡ lỗi, không lưu lại.
  media: trimSlash(qs.get('media') || (HTTP_PAGE ? location.origin : '')),
  dres: trimSlash(cfgValue('dres', 'aicFinalDres', 'https://eventretrieval.one')),
  soloaiServer: true, // backend có route POST /api/submission/solo
};
if (!CFG.media) CFG.media = CFG.backend;
store.del('aicFinalMedia'); // xóa giá trị Media base cũ (ô này đã bỏ khỏi Cài đặt)

function errText(body, status) {
  const d = body && (body.error || body.detail);
  if (!d) return `HTTP ${status}`;
  return typeof d === 'string' ? d : JSON.stringify(d);
}
async function api(path, opts = {}) {
  const res = await fetch(CFG.backend + path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(errText(body, res.status));
  return body;
}
const postJSON = (path, data, signal) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal,
});

// Media: nginx /media trước, lỗi thì tự chuyển sang route FastAPI (giống frontend cũ).
const MEDIA = { frames: null, videos: null, asr: null }; // null = chưa biết, true = dùng được, false = không có
// Hỏi Media base có gì: 404 → không có /media (dùng thẳng API).
// server.py trả {proxy:true, …}: nó tự lấy video/ảnh ở máy trước, thiếu thì lấy từ backend → luôn dùng /media.
fetch(`${CFG.media}/media/`, { cache: 'no-store' }).then(async r => {
  if (r.status === 404 && !String(r.headers.get('content-type')).includes('json')) { for (const k in MEDIA) if (MEDIA[k] === null) MEDIA[k] = false; return; }
  const caps = await r.json().catch(() => null);
  if (!caps || typeof caps !== 'object') return;
  MEDIA.local = caps.proxy ? { videos: caps.local_videos || 0, frames: caps.local_frame_dirs || 0 } : null;
  for (const k of ['frames', 'videos', 'asr']) if (typeof caps[k] === 'boolean' && MEDIA[k] === null) MEDIA[k] = caps.proxy ? caps[k] : (caps[k] ? null : false);
}).catch(() => {});

// ── B2 Backblaze integration ──
// 1. Load frame hash mapping & video batch metadata once at startup.
// 2. Cache download auth token in sessionStorage + localStorage (valid 23h).
//    All image/video requests go DIRECTLY to B2 – zero backend load.
const B2_CACHE_KEY = 'aic_b2_dl_auth';
window.B2_MAPPING = null;
window.VIDEO_METADATA = null;
window.B2_DL_AUTH = null;  // { token, download_url, bucket, expires_in, expires_at }

try {
  const cached = sessionStorage.getItem(B2_CACHE_KEY) || localStorage.getItem(B2_CACHE_KEY);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (parsed && parsed.token && (!parsed.expires_at || Date.now() < parsed.expires_at)) {
      window.B2_DL_AUTH = parsed;
      console.debug(`[B2] Restored download token from cache (${parsed.download_url})`);
    }
  }
} catch (e) {}

fetch('./b2_mapping.json').then(r => r.json())
  .then(d => { window.B2_MAPPING = d; console.debug(`[B2] Loaded frame mapping for ${Object.keys(d).length} videos`); })
  .catch(() => console.warn('[B2] b2_mapping.json not found, frames will use legacy API'));

fetch('./video_metadata.json').then(r => r.json())
  .then(d => {
    if (d && !d.detail) {
      window.VIDEO_METADATA = d;
      console.debug(`[B2] Loaded video metadata for ${Object.keys(d).length} videos`);
    }
  })
  .catch(() => console.warn('[B2] video_metadata.json not found'));

function fetchB2DownloadToken() {
  fetch(`${CFG.backend}/api/b2_download_token`)
    .then(r => r.json())
    .then(d => {
      const expires_at = Date.now() + ((d.expires_in || 82800) - 3600) * 1000;
      const data = { ...d, expires_at };
      window.B2_DL_AUTH = data;
      try {
        sessionStorage.setItem(B2_CACHE_KEY, JSON.stringify(data));
        localStorage.setItem(B2_CACHE_KEY, JSON.stringify(data));
      } catch (e) {}
      console.debug(`[B2] Download token ready → direct B2 access enabled (download_url=${d.download_url})`);
      // Update any images currently loaded through backend proxy
      document.querySelectorAll('img[data-v][data-f]').forEach(img => {
        if (img.src && img.src.includes('/api/b2_media/')) {
          img.src = frameUrl(img.dataset.v, +img.dataset.f);
        }
      });
    })
    .catch(e => console.warn('[B2] Could not get download token, using backend proxy as fallback', e));
}

if (!window.B2_DL_AUTH || (window.B2_DL_AUTH.expires_at && window.B2_DL_AUTH.expires_at - Date.now() < 7200000)) {
  fetchB2DownloadToken();
}

const pad8 = n => String(n).padStart(8, '0');
const apiFrameUrl = (v, f) => `${CFG.backend}/api/frames/${enc(v)}/${f}`;
const apiVideoUrl = v => `${CFG.backend}/api/videos/${enc(v)}`;

// frameUrl: direct B2 with auth token (fastest)
// → fallback: backend proxy → fallback: /media/ → fallback: legacy API
const frameUrl = (v, f, framePath) => {
  if (framePath) {
    if (framePath.includes('batch1_candidates/')) {
      const rel = framePath.split('batch1_candidates/')[1].replace(/^\/+/, '');
      const filePath = `frames/batch1_candidates/${rel}`;
      if (window.B2_DL_AUTH) {
        const { download_url, bucket, token } = window.B2_DL_AUTH;
        return `${download_url}/file/${bucket}/${filePath}?Authorization=${token}`;
      }
      return `${CFG.backend}/api/b2_media/${filePath}`;
    }
    if (framePath.includes('batch2_candidates/')) {
      const rel = framePath.split('batch2_candidates/')[1].replace(/^\/+/, '');
      const filePath = `frames/batch2_candidates/${rel}`;
      if (window.B2_DL_AUTH) {
        const { download_url, bucket, token } = window.B2_DL_AUTH;
        return `${download_url}/file/${bucket}/${filePath}?Authorization=${token}`;
      }
      return `${CFG.backend}/api/b2_media/${filePath}`;
    }
  }

  if (window.B2_MAPPING && window.B2_MAPPING[v]) {
    const hashFolder = window.B2_MAPPING[v];
    // batch1 candidate frames are sampled on a 5-frame grid (0, 5, 10, ...).
    // Snapping f to nearest multiple of 5 ensures file exists on B2 without 404 falling back to backend.
    const snappedF = Math.round(Number(f) / 5) * 5;
    const filePath = `frames/batch1_candidates/${hashFolder}/${pad8(snappedF)}.jpg`;
    if (window.B2_DL_AUTH) {
      const { download_url, bucket, token } = window.B2_DL_AUTH;
      return `${download_url}/file/${bucket}/${filePath}?Authorization=${token}`;
    }
    // Token not ready yet — use backend proxy (307 redirect)
    return `${CFG.backend}/api/b2_media/${filePath}`;
  }
  return MEDIA.frames === false ? apiFrameUrl(v, f) : `${CFG.media}/media/frames/${v}/f_${pad8(f)}.jpg`;
};

// videoUrl: direct B2 with auth token
// → fallback: backend proxy → fallback: /media/ → fallback: legacy API
// videoUrl: LUÔN đi qua backend (/api/videos/<id>) → video lấy từ file trên server (VIDEOS_DIR), không tải thẳng từ B2.
const videoUrl = v => apiVideoUrl(v);

const BROKEN_IMG = 'data:image/svg+xml;utf8,' + enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#0a1626"/><path d="M62 58l12-14 9 10 6-6 11 10z" fill="none" stroke="#3b5a80" stroke-width="3"/></svg>');

// Mọi <img data-v data-f> tự fallback media → API → placeholder.
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.v) return;
  const api = apiFrameUrl(img.dataset.v, img.dataset.f);
  if (img.src !== api && !img.dataset.fb) {
    img.dataset.fb = '1';
    if (MEDIA.frames === null) MEDIA.frames = false;
    img.src = api;
  } else if (img.src !== BROKEN_IMG) {
    img.src = BROKEN_IMG;
  }
}, true);
document.addEventListener('load', e => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.dataset.v && !img.dataset.fb && MEDIA.frames === null && img.src.includes('/media/frames/')) MEDIA.frames = true;
}, true);
const imgTag = (v, f, cls = '', framePath = '') => `<img class="${cls}" data-v="${esc(v)}" data-f="${f}" src="${esc(frameUrl(v, f, framePath))}" loading="lazy" draggable="false" alt="">`;

// Gán src cho <video> với fallback media → API.
function setVideoSrc(el, v, t = 0, onFail) {
  const fallback = apiVideoUrl(v);
  el.dataset.v = v;
  el.onerror = () => {
    if (el.dataset.v !== v) return;
    if (el.src !== fallback) {
      if (MEDIA.videos === null) MEDIA.videos = false;
      el.src = fallback; el.load(); seekWhenReady(el, t);
      if (el.dataset.play === '1') el.play().catch(() => {});
    } else if (onFail) onFail();
  };
  el.onloadedmetadata = () => { if (el.src.includes('/media/videos/') && MEDIA.videos === null) MEDIA.videos = true; };
  el.src = videoUrl(v);
  seekWhenReady(el, t);
}
function seekWhenReady(el, t) {
  if (!Number.isFinite(t)) return;
  if (el.readyState >= 1) el.currentTime = t;
  else el.addEventListener('loadedmetadata', () => { el.currentTime = t; }, { once: true });
}

// FPS lấy từ backend metadata (GET /api/video-fps). Nếu lúc mở trang backend chưa sẵn sàng
// thì tự lấy lại khi cần (mỗi lần trích frame / mở video) và ngay khi kết nối lại backend.
let FPS = null, fpsLoading = null;
function fpsReady() {
  if (FPS) return Promise.resolve(FPS);
  if (!fpsLoading) {
    fpsLoading = fetch(`${CFG.backend}/api/video-fps`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(v => { if (v && (v.overrides || Number(v.default_fps) > 0)) FPS = v; return FPS; })
      .catch(() => null)
      .finally(() => { fpsLoading = null; if (FPS && $('#videoModal')?.classList.contains('open')) updateVmClock(); });
  }
  return fpsLoading;
}
fpsReady();
function fpsOf(v) {
  if (!FPS || !v) return null;
  const x = Number(FPS.overrides?.[v] ?? FPS.default_fps);
  return x > 0 ? x : null;
}
const fps25 = v => fpsOf(v) || 25; // chỉ dùng khi frontend cũ cũng mặc định 25 (DRES ms, ước lượng hiển thị)
const tOf = r => { const f = fpsOf(r.video_id); return f ? r.frame_id / f : Number(r.timestamp_seconds) || 0; };

/* ════════════════════ 3. State ════════════════════ */
const TASK_LABEL = { kis: 'KIS', vqa: 'Q&A', trake: 'TRAKE' };
const S = {
  task: 'kis',
  trakeUndo: (() => { try { return JSON.parse(store.get('aicTrakeUndo') || 'null'); } catch { return null; } })(), // danh sách trước lần nộp TRAKE gần nhất
  family: store.get('aicFamily', 'standard'),
  fusion: store.get('aicFusion', 'late'),
  mm: store.get('aicMM', 'only_visual'),
  results: [],        // danh sách frame đang hiển thị (TRAKE: đã flatten)
  trake: null,        // kết quả TRAKE gốc theo video
  meta: null,
  view: store.get('aicView', 'grid'),
  selected: new Map(),// video đã chọn để lọc frame tốt nhất
  lastGlobal: [],     // kết quả search toàn cục gần nhất
  filterBase: null,   // để “↶ Gốc” khôi phục
  cart: [],           // {key, video_id, frame_id, t, src, label}
  answers: {},        // câu trả lời Q&A theo key video/frame
  cartShare: store.get('aicCartShare', '1') === '1',
  hoverPlay: store.get('aicHoverPlay', '1') === '1',
  teamName: store.get('teamMemberName', ''),
};
// DRES / ban tổ chức dùng id video chính thức (S01-V011). Chỉ mục (Qdrant, manifest, fps) giữ hậu tố `_h264` của bản
// mã hoá lại (S01-V002…V011; riêng S01-V008 có cả hai dạng) → chỉ bỏ hậu tố này ở biên nộp DRES, mọi nơi khác giữ id chỉ mục.
function dresVid(v) { return String(v ?? '').replace(/_h264$/i, ''); }
const itemOf = (v, f, t, framePath) => ({ key: `${v}/${f}`, video_id: v, frame_id: Number(f), t: Number(t) || 0, src: frameUrl(v, f, framePath), label: `${v}-${f}` });
const itemFromResult = r => itemOf(r.video_id, r.frame_id, tOf(r), r.frame_path);

/* ════════════════════ 4. Task & chế độ tìm kiếm ════════════════════ */
function setTask(t) {
  S.task = t;
  setVideoPane(false);
  $$('#taskTabs [data-task], #cartTabs [data-task]').forEach(b => b.classList.toggle('active', b.dataset.task === t));
  $('#paneQuery').hidden = t === 'trake';
  $('#paneTrake').hidden = t !== 'trake';
  $('#btnDeepseek').hidden = t !== 'trake';
  $('#filterRow').hidden = t === 'trake';
  $('#queryLabel').textContent = t === 'vqa' ? 'Câu hỏi Q&A' : 'Mô tả cảnh';
  $('#vmAnswer').hidden = t !== 'vqa';
  $('#vmSubmit').hidden = t === 'trake';
  renderCart();
}

// Tab VIDEO như bản cũ: ẩn phần tìm kiếm, hiện ô mở video theo ID (task đang chọn giữ nguyên).
function setVideoPane(on) {
  $('#paneVideo').hidden = !on;
  $('#searchBox').hidden = on;
  $('#videoTab').classList.toggle('active', on);
  $$('#taskTabs [data-task]').forEach(b => b.classList.toggle('active', !on && b.dataset.task === S.task));
  if (on) setTimeout(() => $('#vsId').focus(), 30);
}
// Tìm Video ID thật (server.py: ở máy trước, rồi backend). Chấp nhận L21_V001, l21_v1, N051-V001, N051_V001, N051-V001.mov…
// Gõ sai → báo "không tìm thấy" (kèm gợi ý), KHÔNG chuyển sang tìm kiếm.
async function resolveVideo(raw) {
  const q = String(raw || '').trim();
  if (!q) return { found: false, suggest: [] };
  try {
    const r = await fetch(`${CFG.media}/media/find?q=${enc(q)}`, { cache: 'no-store' });
    const d = r.ok ? await r.json().catch(() => null) : null;
    if (d && typeof d.found === 'boolean') return d;
  } catch { /* không chạy qua server.py → hỏi thẳng backend */ }
  const id = q.replace(/\.(mp4|mov|mkv|webm|avi|m4v)$/i, '').toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(id)) return { found: false, suggest: [] };
  try {
    const r = await fetch(apiVideoUrl(id), { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    return { found: r.ok, id, source: 'server', suggest: [] };
  } catch (e) { return { found: false, suggest: [], backend_error: netMsg(e) }; }
}
function notFoundMsg(raw, res) {
  let msg = `Không tìm thấy video “${raw}”`;
  if (res.backend_error) msg += ' trên máy (chưa kiểm tra được trên server vì mất kết nối backend)';
  if (res.suggest?.length) msg += ` — có phải: ${res.suggest.join(', ')}?`;
  return msg.endsWith('?') ? msg : `${msg}.`;
}
async function openVideoService() {
  const raw = $('#vsId').value.trim();
  if (!raw) { toast('Nhập Video ID, ví dụ: L21_V001 hoặc N051-V001.', 'error'); $('#vsId').focus(); return; }
  const res = await resolveVideo(raw);
  if (!res.found) { toast(notFoundMsg(raw, res), 'error', 5000); $('#vsId').focus(); $('#vsId').select(); return; }
  $('#vsId').value = res.id;
  openVideo(res.id, Math.max(0, Number($('#vsTime').value) || 0));
}

const MM_LABEL = { only_visual: 'Only Visual', visual_ocr: 'Visual + OCR', visual_asr: 'Visual + ASR' };
function renderMode() {
  $$('#familySeg button').forEach(b => b.classList.toggle('active', b.dataset.family === S.family));
  $$('#paneQuery [data-fam]').forEach(el => { el.hidden = el.dataset.fam !== S.family; });
  $$('[data-fusion]').forEach(b => b.classList.toggle('active', b.dataset.fusion === S.fusion));
  $$('[data-mm]').forEach(b => b.classList.toggle('active', b.dataset.mm === S.mm));
  $('#modeBadge').textContent = modeLabel();
  store.set('aicFamily', S.family); store.set('aicFusion', S.fusion); store.set('aicMM', S.mm);
}
function modeLabel() {
  if (S.family === 'video_lock') return 'Lock-video · DeepSeek';
  if (S.family === 'multi') return MM_LABEL[S.mm];
  return S.fusion === 'late' ? 'Late / RRF' : 'Early Fusion';
}
function searchConfig() {
  if (S.family === 'video_lock') return { family: 'video_lock', search_mode: 'video_lock', fusion_mode: 'late', multimodal_mode: 'none', deepseek_vision: true };
  // Multi-mode = Standard + multimodal_mode rõ ràng (đúng hợp đồng API).
  if (S.family === 'multi') return { family: 'multi', search_mode: 'standard', fusion_mode: 'late', multimodal_mode: S.mm, deepseek_vision: false };
  return { family: 'standard', search_mode: 'standard', fusion_mode: S.fusion, multimodal_mode: 'none', deepseek_vision: false };
}
// Chữ trong "ngoặc kép" là gợi ý OCR/ASR mạnh nhất; không có thì dùng cả câu.
function quotedParts(q) {
  const out = [];
  for (const re of [/["“]([^"”]+)["”]/g, /'([^']+)'/g]) { let m; while ((m = re.exec(q))) if (m[1].trim()) out.push(m[1].trim()); }
  return [...new Set(out)].join(' ').trim();
}
function ocrAsrQueries(q, cfg) {
  const base = String(q || '').trim(), quoted = quotedParts(base);
  if (cfg.multimodal_mode === 'visual_ocr') return { ocr_query: quoted || base, asr_query: null };
  if (cfg.multimodal_mode === 'visual_asr') return { ocr_query: null, asr_query: quoted || base };
  if (cfg.family === 'standard') return { ocr_query: base || null, asr_query: base || null };
  return { ocr_query: null, asr_query: null };
}

/* ── TRAKE: sự kiện & anchor ── */
const EV_MIN = 1, EV_MAX = 10;
function renderEvents(n, values) {
  n = Math.max(EV_MIN, Math.min(EV_MAX, n || 2));
  const cur = values || $$('#evList textarea').map(t => t.value);
  $('#evList').innerHTML = Array.from({ length: n }, (_, i) =>
    `<div class="ev-row"><b>E${i + 1}</b><textarea rows="2" data-ev="${i}" placeholder="Mô tả sự kiện ${i + 1}…">${esc(cur[i] || '')}</textarea></div>`).join('');
  $('#evCount').value = n;
}
const trakeEvents = () => $$('#evList textarea').map(t => t.value.trim()).filter(Boolean);
function splitEvents(text) {
  return String(text).split(/\n+|->|→|;/).map(s => s.replace(/^\s*(e\d+|event\s*\d+|\d+)\s*[:.)-]\s*/i, '').trim()).filter(Boolean);
}
function trakeManual() {
  const video = $('#anVideo').value.trim().replace(/\.mp4$/i, '');
  const frameText = $('#anFrame').value.trim();
  const frame = frameText === '' ? null : Number(frameText);
  if (frameText !== '' && (!Number.isInteger(frame) || frame < 0)) throw new Error('Anchor frame phải là số nguyên không âm.');
  if (video && !/^[A-Za-z0-9_-]+$/.test(video)) throw new Error('Anchor video chỉ gồm chữ, số, “_” hoặc “-”.');
  return { video_id: video || null, anchor_frame_id: frame, anchor_query: $('#anQuery').value.trim() || null };
}
function updateAnchorHint() {
  const v = $('#anVideo').value.trim(), f = $('#anFrame').value.trim(), q = $('#anQuery').value.trim();
  const hint = $('#anHint');
  const parts = [v && `video ${v}`, f && `frame ${f}`, q && 'query đã nhập'].filter(Boolean);
  hint.textContent = parts.length ? `Anchor hiện tại: ${parts.join(' · ')}.` : 'Để trống để tìm TRAKE tự động.';
  hint.classList.toggle('on', parts.length > 0);
  $('#btnDeepseek').disabled = !(v || q);
  if (parts.length) $('#anchorBox').open = true;
}
function setTrakeAnchor(v, frame = null, switchTask = true) {
  if (!v) return;
  $('#anVideo').value = v;
  if (frame !== null && frame !== undefined) $('#anFrame').value = String(frame);
  if (switchTask && S.task !== 'trake') setTask('trake');
  updateAnchorHint();
  toast(`⚓ Anchor TRAKE: ${v}${frame != null ? ` · frame ${frame}` : ''}`, 'success');
}

/* ════════════════════ 5. Tìm kiếm ════════════════════ */
const searchCache = new Map();
let searchCtl = null;

function collectQueries() {
  if (S.task === 'trake') return trakeEvents();
  const q = $('#query').value.trim();
  return q ? [q] : [];
}

async function translateText(text, sl = 'vi', tl = 'en') {
  if (!text) return '';
  try {
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${enc(text)}`);
    const d = await r.json();
    return d[0].map(x => x[0]).join('');
  } catch { return text; }
}

async function runSearch(opts = {}) {
  const queries = collectQueries();
  if (!queries.length) {
    toast(S.task === 'trake' ? 'Nhập ít nhất một sự kiện TRAKE.' : 'Nhập nội dung cần tìm.', 'error');
    (S.task === 'trake' ? $('#evList textarea') : $('#query'))?.focus();
    return;
  }
  let manual = null;
  if (S.task === 'trake') {
    try { manual = trakeManual(); } catch (e) { toast(e.message, 'error'); return; }
    if (opts.deepseek) {
      if (manual.anchor_frame_id !== null && !manual.video_id) { toast('Anchor frame cần có Anchor video.', 'error'); return; }
      if (!manual.video_id && !manual.anchor_query) { toast('Chọn Anchor video hoặc nhập Anchor query trước.', 'error'); return; }
    }
  }
  // Search mới = tập ứng viên mới: bỏ chọn video & lịch sử lọc của lần trước.
  clearSelected();
  setFilterBase(null);
  addHistory({ task: S.task, q: S.task === 'trake' ? queries.join(' → ') : queries[0], events: S.task === 'trake' ? queries : null });

  const task = S.task, cfg = task === 'trake' ? null : searchConfig();
  const translate = $('#translate').checked;
  const key = JSON.stringify([task, cfg, queries, translate, opts.deepseek ? manual : null]);
  if (searchCache.has(key)) { const c = searchCache.get(key); showResults(c.data, { ...c.meta, cached: true }); return; }

  searchCtl?.abort();
  const ctl = searchCtl = new AbortController();
  setLoading(true);
  const t0 = performance.now();
  try {
    const visual = translate ? await Promise.all(queries.map(q => translateText(q))) : queries;
    let endpoint, body;
    if (task === 'trake') {
      endpoint = 'trake';
      body = { events: visual, top_k_videos: 10 };
      // Nút thường = tìm TRAKE rẻ; chỉ nút DeepSeek mới gửi anchor (tránh lỡ Enter tốn Vision).
      if (opts.deepseek) body = { ...body, ...manual };
    } else if (task === 'vqa') {
      endpoint = 'qa';
      body = { question: visual[0], top_k: 100, search_mode: cfg.search_mode, fusion_mode: cfg.fusion_mode, multimodal_mode: cfg.multimodal_mode, deepseek_vision: cfg.deepseek_vision, deepseek_rerank: false, ...ocrAsrQueries(queries[0], cfg) };
    } else {
      endpoint = 'kis';
      body = { query: visual[0], top_k: 100, search_mode: cfg.search_mode, fusion_mode: cfg.fusion_mode, multimodal_mode: cfg.multimodal_mode, deepseek_vision: cfg.deepseek_vision, ...ocrAsrQueries(queries[0], cfg) };
    }
    const env = await postJSON(`/api/search/${endpoint}`, body, ctl.signal);
    const meta = { task, mode: task === 'trake' ? (opts.deepseek ? 'DeepSeek anchor' : 'TRAKE') : modeLabel(), ms: env.meta?.elapsed_ms ?? Math.round(performance.now() - t0), translated: translate };
    searchCache.set(key, { data: env.data, meta });
    if (searchCtl === ctl) showResults(env.data, meta);
  } catch (e) {
    if (e.name !== 'AbortError') { toast(`Lỗi tìm kiếm: ${netMsg(e)}`, 'error', 4500); if (e instanceof TypeError) refreshHealth(); }
  } finally {
    if (searchCtl === ctl) setLoading(false);
  }
}

function setLoading(on) {
  const box = $('#results');
  box.classList.toggle('searching', on);
  $('#loadingBanner')?.remove();
  if (!on) { if (!S.results.length) box.innerHTML = emptyHTML(); $('#countBadge').textContent = `${S.results.length} kết quả`; return; }
  if (!S.results.length) {
    box.innerHTML = '<div class="empty"><div class="spinner"></div><p>Đang tìm trong chỉ mục đa phương thức…</p></div>';
  } else {
    box.insertAdjacentHTML('afterbegin', '<div class="loading-banner" id="loadingBanner"><span class="spinner sm"></span> Đang tìm kết quả mới… (giữ kết quả cũ để bạn tiếp tục xem)</div>');
  }
  $('#countBadge').textContent = 'Đang tìm…';
}

/* ── Lọc frame tốt nhất trong các video đã chọn (POST /api/search/selected-videos) ── */
const SELECT_MAX = 20;
function clearSelected() { S.selected.clear(); refreshSelected(); }
function toggleSelected(r) {
  const v = String(r.video_id);
  if (S.selected.has(v)) S.selected.delete(v);
  else {
    if (S.selected.size >= SELECT_MAX) { toast(`Chỉ chọn tối đa ${SELECT_MAX} video mỗi lần.`); return; }
    S.selected.set(v, { video_id: v, frame_id: Number(r.frame_id) });
  }
  refreshSelected();
}
function refreshSelected() {
  $('#selCount').textContent = S.selected.size ? `(${S.selected.size})` : '';
  $$('#results .card-f').forEach(c => {
    const on = S.selected.has(c.dataset.v);
    c.classList.toggle('sel', on);
    const b = c.querySelector('.pk');
    if (b) { b.classList.toggle('on', on); b.textContent = on ? '✓ Đã chọn' : 'Chọn video'; }
  });
  $$('#results [data-gact="pick"]').forEach(b => { b.textContent = S.selected.has(b.dataset.v) ? '✓ Đã chọn' : 'Chọn video'; });
}
function setFilterBase(list) {
  S.filterBase = list && list.length ? list : null;
  $('#btnRestore').hidden = !S.filterBase;
}
async function filterSelected() {
  if (S.task === 'trake') { toast('TRAKE không dùng lọc video; hãy dùng anchor.'); return; }
  const sel = [...S.selected.values()];
  if (!sel.length) { toast('Bấm “Chọn video” trên ít nhất một kết quả trước.'); return; }
  const query = $('#query').value.trim();
  if (!query) { toast('Không có query hiện tại để lọc.', 'error'); return; }
  searchCtl?.abort();
  const ctl = searchCtl = new AbortController();
  setLoading(true);
  try {
    const env = await postJSON('/api/search/selected-videos', { query, selected_frames: sel, top_k_per_video: 100, output_limit: 100 }, ctl.signal);
    const results = Array.isArray(env.data) ? env.data.slice(0, 100) : [];
    const original = S.lastGlobal.slice(0, 100);
    clearSelected();
    showResults(results, { task: S.task, mode: `Lọc ${sel.length} video`, ms: env.meta?.elapsed_ms, filtered: true });
    setFilterBase(original);
    toast(results.length ? `Đã lọc ${results.length} frame tốt nhất trong ${sel.length} video.` : 'Không tìm thấy frame mới trong các video đã chọn.', results.length ? 'success' : 'info');
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Lỗi lọc video: ${e.message}`, 'error');
  } finally {
    if (searchCtl === ctl) setLoading(false);
  }
}
function restoreOriginal() {
  if (!S.filterBase) return;
  const orig = S.filterBase;
  clearSelected();
  showResults(orig, { task: S.task, mode: 'Kết quả gốc' });
  setFilterBase(null);
  toast('Đã quay lại kết quả search ban đầu.');
}

/* ════════════════════ 6. Hiển thị kết quả ════════════════════ */
function flattenTrake(list) {
  const flat = [];
  (list || []).forEach(v => (v.frame_ids || []).forEach((f, ei) => {
    if (f === null || f === undefined) return; // sự kiện bị thiếu
    flat.push({ video_id: v.video_id, frame_id: f, timestamp_seconds: v.timestamps_seconds?.[ei], event_index: ei, rank: v.rank, score: v.moment_scores?.[ei] });
  }));
  return flat;
}

function showResults(data, meta = {}) {
  hoverStop();
  if (meta.task === 'trake') {
    S.trake = Array.isArray(data) ? data : [];
    S.results = flattenTrake(S.trake);
  } else {
    S.trake = null;
    S.results = (Array.isArray(data) ? data : []).slice(0, 100);
    if (!meta.filtered) S.lastGlobal = S.results.slice();
  }
  S.meta = meta;
  render();
  $('#content').scrollTop = 0;
  prefetchVideos(S.results, 20);
  prefetchBoundaries(S.results, 20, 5);
  if (TX.terms.length || TX.show) txEnsureAndApply();
}

function emptyHTML() {
  if (S.meta) return '<div class="empty"><div class="big">🔍</div><p>Không có kết quả. Thử đổi chế độ tìm kiếm hoặc bật dịch VI → EN.</p></div>';
  return `<div class="empty"><div class="big">🔎</div>
    <h3>Nhập truy vấn và nhấn Enter để tìm kiếm</h3>
    <ul>
      <li>Click → xem video · Chuột phải → dải keyframe · Chuột giữa / kéo thả / nút + → thêm vào danh sách nộp</li>
      <li>Giữ <kbd>Alt</kbd> + di chuột → xem lớn · Di chuột → phát video quanh frame</li>
      <li>Ô ✨ phía trên → tìm chữ OCR / lời thoại ASR trong K kết quả</li>
      <li>Nhấn <kbd>/</kbd> để về ô tìm kiếm · bấm ⚡ AIC 2026 hoặc <kbd>?</kbd> để xem phím tắt</li>
    </ul></div>`;
}

function cardHTML(r, i) {
  const sel = S.selected.has(String(r.video_id));
  const inCart = S.cart.some(c => c.key === `${r.video_id}/${r.frame_id}`);
  const score = Number(r.score), lbl = `${r.video_id}-${r.frame_id}`;
  return `<div class="card-f${sel ? ' sel' : ''}${inCart ? ' in-cart' : ''}" data-i="${i}" data-v="${esc(r.video_id)}" draggable="true" title="${esc(lbl)}${Number.isFinite(score) ? ` · score ${score.toFixed(3)}` : ''} — click: xem video · chuột phải: frame lân cận · chuột giữa: thêm">
    <div class="thumb">${imgTag(r.video_id, r.frame_id, '', r.frame_path)}
      ${r.event_index != null ? `<span class="ev">E${r.event_index + 1}</span>`
        : `<button class="pk${sel ? ' on' : ''}" data-act="pick" title="Chọn ${esc(r.video_id)} để lọc frame riêng">${sel ? '✓ Đã chọn' : 'Chọn video'}</button>`}
      <span class="rk">${i + 1}</span>
      <div class="acts"><button data-act="anchor" title="Chọn video & frame này làm anchor TRAKE">TRAKE</button><button data-act="strip" title="Frame lân cận (chuột phải)">☰</button><button class="plus" data-act="add" title="Thêm vào danh sách nộp (chuột giữa)">+</button></div>
      <div class="cap"><span class="lbl">${esc(lbl)}</span><span class="t">${fmtTime(tOf(r))}</span></div>
      <div class="vprog"></div>
    </div>
    <div class="tx" hidden></div>
  </div>`;
}

function render() {
  const box = $('#results');
  $('#countBadge').textContent = `${S.results.length} kết quả`;
  $('#viewToggle').checked = Boolean(S.trake) || S.view === 'group';
  updateSummary();
  if (!S.results.length) { box.innerHTML = emptyHTML(); return; }
  if (S.trake) box.innerHTML = trakeHTML();
  else if (S.view === 'group') box.innerHTML = groupHTML();
  else box.innerHTML = `<div class="grid">${S.results.map(cardHTML).join('')}</div>`;
  applyTx();
}

function updateSummary() {
  const m = S.meta;
  $('#summary').textContent = m ? [`${TASK_LABEL[m.task] || ''}`, m.mode, m.ms != null ? `${(m.ms / 1000).toFixed(2)}s` : '', m.cached ? 'cache' : '', m.translated ? 'đã dịch' : ''].filter(Boolean).join(' · ') : '';
}

function groupHTML() {
  const groups = new Map();
  S.results.forEach((r, i) => { if (!groups.has(r.video_id)) groups.set(r.video_id, []); groups.get(r.video_id).push(i); });
  return [...groups].map(([v, idx]) => `<section class="vgroup" data-v="${esc(v)}">
    <header><b>${esc(v)}</b><span class="muted">${idx.length} frame · tốt nhất #${idx[0] + 1}</span><div class="spacer"></div>
      <button class="btn xs" data-gact="pick" data-v="${esc(v)}">${S.selected.has(v) ? '✓ Đã chọn' : 'Chọn video'}</button>
      <button class="btn xs" data-gact="open" data-v="${esc(v)}">▶ Mở video</button></header>
    <div class="grid">${idx.map(i => cardHTML(S.results[i], i)).join('')}</div></section>`).join('');
}

function trakeHTML() {
  let i = 0;
  return S.trake.map((v, gi) => {
    const cards = [];
    (v.frame_ids || []).forEach(f => { if (f !== null && f !== undefined) { cards.push(cardHTML(S.results[i], i)); i++; } });
    const missing = Array.isArray(v.missing_events) && v.missing_events.length ? ` · thiếu E${v.missing_events.map(x => Number(x) + 1).join(', E')}` : '';
    return `<section class="vgroup trake" data-v="${esc(v.video_id)}">
      <header><b>#${v.rank ?? gi + 1} ${esc(v.video_id)}</b><span class="muted">tổng ${Number(v.total_score ?? 0).toFixed(3)}${missing}</span><div class="spacer"></div>
        <button class="btn xs gold" data-gact="key" data-g="${gi}" title="Chốt video cho cả team và mở workspace TRAKE với chuỗi frame đã tìm">🔑 Làm Key</button>
        <button class="btn xs" data-gact="chain" data-g="${gi}" title="Thêm cả chuỗi E1..En vào danh sách nộp theo thứ tự">＋ Thêm chuỗi</button>
        <button class="btn xs" data-gact="open" data-v="${esc(v.video_id)}">▶ Mở</button></header>
      <div class="grid">${cards.join('')}</div></section>`;
  }).join('');
}

function setView(v) {
  S.view = v; store.set('aicView', v);
  if (S.trake) { toast('Kết quả TRAKE luôn hiển thị theo video.'); }
  render();
}

/* ── Tương tác trên thẻ kết quả (event delegation) ── */
function resultAt(el) { const c = el.closest('.card-f'); return c ? [c, S.results[+c.dataset.i]] : [null, null]; }
function bindResults() {
  const box = $('#results');
  box.addEventListener('click', e => {
    const chip = e.target.closest('.tx-chip');
    if (chip && chip.dataset.t) { e.stopPropagation(); const [, r] = resultAt(chip); openVideo(r.video_id, +chip.dataset.t, { q: TX.q }); return; }
    const g = e.target.closest('[data-gact]');
    if (g) { groupAction(g); return; }
    const [card, r] = resultAt(e.target);
    if (!r) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') addToCart(itemFromResult(r));
    else if (act === 'strip') openStrip(r.video_id, r.frame_id);
    else if (act === 'anchor') setTrakeAnchor(r.video_id, r.frame_id, true);
    else if (act === 'pick') toggleSelected(r);
    else openVideo(r.video_id, tOf(r), { q: TX.q });
  });
  box.addEventListener('mousedown', e => { if (e.button === 1 && e.target.closest('.card-f')) e.preventDefault(); });
  box.addEventListener('auxclick', e => { if (e.button !== 1) return; const [, r] = resultAt(e.target); if (r) { e.preventDefault(); addToCart(itemFromResult(r)); } });
  box.addEventListener('contextmenu', e => { const [, r] = resultAt(e.target); if (r) { e.preventDefault(); openStrip(r.video_id, r.frame_id); } });
  box.addEventListener('dragstart', e => { const [, r] = resultAt(e.target); if (r) startDrag(e, itemFromResult(r)); });
  box.addEventListener('mouseover', e => { const [card] = resultAt(e.target); if (card && card !== HP.card) hoverStart(card); });
  box.addEventListener('mouseout', e => { if (HP.card && !HP.card.contains(e.relatedTarget)) hoverStop(); });
}
function groupAction(btn) {
  const act = btn.dataset.gact;
  if (act === 'open') { const v = btn.dataset.v; const r = S.results.find(x => x.video_id === v); openVideo(v, r ? tOf(r) : 0); return; }
  if (act === 'pick') { const v = btn.dataset.v; const r = S.results.find(x => x.video_id === v); if (r) toggleSelected(r); return; }
  const video = S.trake?.[+btn.dataset.g];
  if (!video) return;
  if (act === 'key') makeTrakeKey(video);
  if (act === 'chain') {
    S.results.filter(r => r.video_id === video.video_id && r.rank === video.rank).forEach(r => addToCart(itemFromResult(r), true, true));
    toast(`Đã thêm chuỗi ${video.video_id} vào danh sách nộp.`, 'success');
  }
}

/* ════════════════════ 7. Hover → phát video ════════════════════ */
const HP = { el: null, card: null, timer: 0, clip: [0, 0] };
const HOVER_DELAY = 220, CLIP_BEFORE = 2, CLIP_AFTER = 8;
function hoverVideo() {
  if (HP.el) return HP.el;
  const v = document.createElement('video');
  v.className = 'hv'; v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.addEventListener('timeupdate', () => {
    const [a, b] = HP.clip;
    if (v.currentTime > b || v.currentTime < a - 0.5) v.currentTime = a; // lặp đoạn quanh frame
    const bar = HP.card?.querySelector('.vprog');
    if (bar) bar.style.width = `${Math.min(100, ((v.currentTime - a) / (b - a)) * 100)}%`;
  });
  v.addEventListener('playing', () => v.classList.add('on'));
  return (HP.el = v);
}
function hoverStart(card) {
  hoverStop();
  HP.card = card;
  if (PV.alt || PV.mode) pvFromCard(card);
  if (!S.hoverPlay) return;
  HP.timer = setTimeout(() => {
    const r = S.results[+card.dataset.i];
    if (!r || HP.card !== card) return;
    const v = hoverVideo(), t = tOf(r);
    HP.clip = [Math.max(0, t - CLIP_BEFORE), t + CLIP_AFTER];
    v.classList.remove('on');
    card.querySelector('.thumb').appendChild(v);
    card.classList.add('playing');
    v.dataset.play = '1';
    if (v.dataset.v !== r.video_id) setVideoSrc(v, r.video_id, HP.clip[0]);
    else seekWhenReady(v, HP.clip[0]);
    setRate(v, holdRate() || 1);
    v.play().catch(() => {});
  }, HOVER_DELAY);
}
function hoverStop() {
  clearTimeout(HP.timer);
  if (HP.card) {
    HP.card.classList.remove('playing');
    const bar = HP.card.querySelector('.vprog'); if (bar) bar.style.width = '0';
  }
  if (HP.el) { HP.el.dataset.play = '0'; HP.el.pause(); HP.el.classList.remove('on'); HP.el.remove(); }
  HP.card = null;
}

/* ════════════════════ 8. OCR / ASR trên K kết quả ════════════════════ */
const TX = { data: new Map(), pending: new Map(), q: '', terms: [], src: 'all', scope: 'video', near: 10, only: false, show: false, gen: 0, loading: false };

async function fetchOcr(v) {
  try {
    const r = await fetch(`${CFG.backend}/api/videos/${enc(v)}/ocr`);
    if (!r.ok) return [];
    const list = await r.json();
    const fps = fps25(v);
    return (Array.isArray(list) ? list : []).filter(x => x && x.text && String(x.text).trim())
      .map(x => ({ src: 'ocr', frame: Number(x.frame_id), t: Number(x.frame_id) / fps, text: String(x.text).trim(), n: norm(x.text) }));
  } catch { return []; }
}
// ASR có thể là start/end hoặc start_seconds/end_seconds, có thể bọc trong {segments|data|results}.
function normalizeAsr(payload) {
  let raw = payload;
  if (!Array.isArray(raw) && raw && typeof raw === 'object') for (const k of ['segments', 'data', 'results', 'asr']) if (Array.isArray(raw[k])) { raw = raw[k]; break; }
  if (!Array.isArray(raw)) return [];
  const num = (...xs) => { for (const x of xs) { if (x === null || x === undefined || x === '' || typeof x === 'boolean') continue; const n = Number(x); if (Number.isFinite(n) && n >= 0) return n; } return null; };
  return raw.map(s0 => {
    const s = s0 && typeof s0.record === 'object' ? { ...s0.record, ...s0 } : (s0 || {});
    const start = num(s.start, s.start_seconds, s.start_time, s.begin, s.startTime);
    const end = num(s.end, s.end_seconds, s.end_time, s.stop, s.endTime, start);
    const text = [s.text, s.transcript, s.asr, s.caption, s.content].find(x => typeof x === 'string' && x.trim());
    return { src: 'asr', t: start, end: end === null ? start : Math.max(start ?? 0, end), text: text ? text.trim() : '' };
  }).filter(s => s.t !== null && s.text).map(s => ({ ...s, n: norm(s.text) })).sort((a, b) => a.t - b.t);
}
async function fetchAsr(v) {
  const urls = [`${CFG.backend}/api/videos/${enc(v)}/asr`];
  if (MEDIA.asr !== false) urls.unshift(`${CFG.media}/media/asr/${enc(v)}.json`);
  for (const url of urls) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) { const segs = normalizeAsr(await r.json()); if (segs.length) return segs; } } catch { /* thử nguồn tiếp theo */ }
  }
  return [];
}
function txLoad(v) {
  if (TX.data.has(v)) return Promise.resolve(TX.data.get(v));
  if (!TX.pending.has(v)) {
    TX.pending.set(v, fpsReady().then(() => Promise.all([fetchOcr(v), fetchAsr(v)])).then(([ocr, asr]) => {
      const d = { ocr, asr }; TX.data.set(v, d); TX.pending.delete(v); return d;
    }));
  }
  return TX.pending.get(v);
}
async function txEnsureAndApply() {
  const videos = [...new Set(S.results.map(r => r.video_id))];
  const todo = videos.filter(v => !TX.data.has(v));
  applyTx();
  if (!todo.length) return;
  const gen = ++TX.gen;
  TX.loading = true;
  let done = 0;
  const badge = $('#txBadge');
  const progress = () => { if (gen !== TX.gen) return; badge.hidden = false; badge.className = 'tx-badge load'; badge.textContent = `⏳ Tải OCR/ASR ${done}/${todo.length} video`; };
  progress();
  const queue = todo.slice();
  const worker = async () => { while (queue.length) { const v = queue.shift(); await txLoad(v).catch(() => {}); done++; progress(); if (done % 6 === 0 && gen === TX.gen) applyTx(); } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (gen === TX.gen) { TX.loading = false; applyTx(); }
}

// Chọn đoạn OCR/ASR khớp gần frame nhất (theo phạm vi đã chọn).
function txMatch(r) {
  const t0 = tOf(r), d = TX.data.get(r.video_id);
  const cands = [];
  if (r.ocr_snippet) cands.push({ src: 'ocr', t: t0, text: r.ocr_snippet, n: norm(r.ocr_snippet) });
  if (r.audio_segment_text) cands.push({ src: 'asr', t: t0, end: t0, text: r.audio_segment_text, n: norm(r.audio_segment_text) });
  if (d) cands.push(...d.ocr, ...d.asr);
  let best = null, bd = Infinity;
  for (const c of cands) {
    if (TX.src !== 'all' && c.src !== TX.src) continue;
    if (!TX.terms.some(t => c.n.includes(t))) continue;
    const dist = c.end != null ? (t0 < c.t ? c.t - t0 : t0 > c.end ? t0 - c.end : 0) : Math.abs(c.t - t0);
    if (TX.scope === 'near' && dist > TX.near) continue;
    if (dist < bd) { bd = dist; best = c; }
  }
  return best;
}
// “Hiện chữ”: OCR gần nhất (±5s) và câu ASR đang nói tại frame.
function txNearest(r) {
  const t0 = tOf(r), d = TX.data.get(r.video_id), out = [];
  let ocr = r.ocr_snippet ? { src: 'ocr', t: t0, text: r.ocr_snippet } : null;
  let asr = r.audio_segment_text ? { src: 'asr', t: t0, text: r.audio_segment_text } : null;
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
const chipHTML = (c, matched) => `<div class="tx-chip${matched ? ' m' : ''}" data-t="${c.t}" title="[${c.src.toUpperCase()} ${fmtTime(c.t)}] ${esc(c.text)} — click để mở video tại đây">${c.src === 'ocr' ? '🔤' : '🎙'} <b>${fmtTime(c.t)}</b> ${matched ? hl(c.text, TX.terms) : esc(c.text)}</div>`;

function applyTx() {
  const active = TX.terms.length > 0;
  let hits = 0; const hitVideos = new Set();
  $$('#results .card-f').forEach(card => {
    const r = S.results[+card.dataset.i]; if (!r) return;
    const box = card.querySelector('.tx');
    let html = '';
    if (active) {
      const m = txMatch(r);
      card.classList.toggle('hit', !!m);
      card.classList.toggle('hide', !m && TX.only);
      if (m) { hits++; hitVideos.add(r.video_id); html = chipHTML(m, true); }
    } else {
      card.classList.remove('hit', 'hide');
      if (TX.show) html = txNearest(r).map(c => chipHTML(c, false)).join('');
    }
    box.innerHTML = html; box.hidden = !html;
  });
  $$('#results .vgroup').forEach(g => g.classList.toggle('hide', active && TX.only && !g.querySelector('.card-f:not(.hide)')));
  $('#txBar').classList.toggle('active', active);
  $('#txClear').hidden = !active;
  const badge = $('#txBadge');
  if (TX.loading) return; // đang tải: giữ badge tiến độ
  badge.hidden = !active;
  badge.className = 'tx-badge';
  if (active) badge.textContent = `🌟 ${hits}/${S.results.length} frame · ${hitVideos.size} video khớp`;
}
function onTxInput() {
  TX.q = $('#txQuery').value;
  TX.terms = TX.q.split(',').map(norm).filter(Boolean);
  if ((TX.terms.length || TX.show) && S.results.length) txEnsureAndApply(); else applyTx();
}
function clearTx() { $('#txQuery').value = ''; onTxInput(); }

/* ════════════════════ 9. Video viewer + OCR/ASR inspector ════════════════════ */
const VM = { v: null, t0: 0, insp: 'all' };
const isOpen = id => $(id).classList.contains('open');
function openOverlay(id) {
  const a = document.activeElement;
  if (a && a !== document.body && !$(id).contains(a)) a.blur(); // để phím tắt đi vào cửa sổ vừa mở
  $(id).classList.add('open');
}
function closeOverlay(id) {
  $(id).classList.remove('open');
  if (id === '#videoModal') $('#vmVideo').pause();
}

function openVideo(v, t = 0, opts = {}) {
  if (!v) return;
  hoverStop();
  if (!FPS) fpsReady(); // backend chưa trả FPS lúc mở trang → lấy lại ngay
  VM.v = v; VM.t0 = Math.max(0, Number(t) || 0);
  const el = $('#vmVideo');
  $('#vmTitle').textContent = v;
  $('#vcId').textContent = v;
  $('#vmBadge').textContent = `bắt đầu ${fmtTime(VM.t0, true)}`;
  setVmTab(opts.q ? 'text' : 'calc');
  el.dataset.play = '1';
  setVideoSrc(el, v, VM.t0, () => toast(`Không mở được video ${v}. Kiểm tra Video ID / Media / Backend.`, 'error', 4500));
  if (MEDIA.local) { // server.py cho biết video lấy từ máy hay từ server
    // Chỉ check X-Source khi URL là backend proxy (không dùng direct B2 — Range fetch sẽ bị CORS block)
    const checkUrl = videoUrl(v);
    if (!checkUrl.includes('backblazeb2.com')) {
      fetch(checkUrl, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' }).then(r => {
        const src = r.headers.get('X-Source');
        if (VM.v === v && src) $('#vmBadge').textContent = `bắt đầu ${fmtTime(VM.t0, true)} · ${src === 'local' ? '📁 từ máy' : '☁ từ server'}`;
      }).catch(() => {});
    }
  }
  setRate(el, holdRate() || vmBaseRate());
  el.play().catch(() => {});
  openOverlay('#videoModal');
  $('#inspQuery').value = opts.q || '';
  renderInspector();
  $('#inspSpin').hidden = TX.data.has(v);
  txLoad(v).then(() => { if (VM.v === v) { $('#inspSpin').hidden = true; renderInspector(); } });
  store.set('video-service-last-id', v);
}
function vmFrame() {
  const el = $('#vmVideo'), fps = fpsOf(VM.v);
  return fps ? Math.round(el.currentTime * fps) : null;
}
function updateVmClock() {
  const el = $('#vmVideo'), f = vmFrame(), fps = fpsOf(VM.v);
  $('#vmTime').textContent = el.currentTime.toFixed(2);
  $('#vmFrame').textContent = f ?? '—';
  $('#vmFps').textContent = fps ? `${fps} fps` : 'chưa có FPS';
  $('#vmAdd').disabled = f === null;
  markInspectorNow(el.currentTime);
}
function setVmTab(tab) {
  $$('#vmTabs button').forEach(b => b.classList.toggle('active', b.dataset.vt === tab));
  $('#vtCalc').hidden = tab !== 'calc';
  $('#vtText').hidden = tab !== 'text';
}
// Kéo thanh tiêu đề để di chuyển cửa sổ video (giống bản cũ).
function bindVideoDrag() {
  const win = $('#vmWin'), head = win.querySelector('.win-head');
  let drag = null, pos = { x: 0, y: 0 };
  head.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = { x: e.clientX - pos.x, y: e.clientY - pos.y }; e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    pos = { x: e.clientX - drag.x, y: Math.max(-innerHeight / 2 + 40, e.clientY - drag.y) };
    win.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  });
  document.addEventListener('mouseup', () => { drag = null; });
  head.addEventListener('dblclick', () => { pos = { x: 0, y: 0 }; win.style.transform = ''; }); // đúp chuột: về giữa
}
function stepVideo(sec) { const el = $('#vmVideo'); el.pause(); el.currentTime = Math.max(0, Math.min(el.duration || 1e9, el.currentTime + sec)); }
const stepFrames = n => stepVideo(n / fps25(VM.v));
const SEEK_STEP = 5; // ← → tua 5 giây, không dừng video
function seekBy(sec) { const el = $('#vmVideo'); el.currentTime = Math.max(0, Math.min(el.duration || 1e9, el.currentTime + sec)); }

// Giữ Shift: video đang xem (cửa sổ video, hoặc video phát khi rê chuột lên ảnh) chạy x1.5; giữ thêm Z: x2.
// Nhả Z → về x1.5; nhả Shift → về tốc độ cũ.
const FAST_RATE = 1.5, FASTER_RATE = 2;
let shiftFast = false, zFast = false;
const holdRate = () => (shiftFast ? (zFast ? FASTER_RATE : FAST_RATE) : 0); // 0 = không giữ phím tăng tốc
const vmBaseRate = () => Number($('#vmSpeed').value) || 1;
function setRate(v, r) { v.defaultPlaybackRate = r; v.playbackRate = r; } // default…: giữ tốc độ khi video nạp lại nguồn
function applyShiftSpeed() {
  const r = holdRate();
  setRate($('#vmVideo'), r || vmBaseRate());
  if (HP.el) setRate(HP.el, r || 1);
  document.body.classList.toggle('fast', r > 0);
  document.body.classList.toggle('faster', r === FASTER_RATE);
}
function onShift(e) {
  const isShift = e.key === 'Shift', isZ = e.code === 'KeyZ' || (e.key || '').toLowerCase() === 'z';
  if (!isShift && !isZ) return;
  const down = e.type === 'keydown';
  if (isZ && down && !e.shiftKey) return; // Z một mình: không làm gì
  const inField = e.target.matches('input, textarea, [contenteditable]');
  // Gõ chữ hoa trong ô nhập của cửa sổ video: bỏ qua. Ngoài lưới thì vẫn tăng tốc video xem trước
  // (thường vừa gõ truy vấn xong, con trỏ còn trong ô tìm kiếm, rồi rê chuột lên ảnh).
  if (down && isOpen('#videoModal') && inField) return;
  // Đang có video xem trước chạy dưới chuột: Shift+Z là tăng tốc, không gõ chữ “Z” vào ô tìm kiếm.
  if (isZ && down && inField && HP.card?.classList.contains('playing')) e.preventDefault();
  if (down && e.repeat) return;
  const before = holdRate();
  if (isShift) shiftFast = down; else zFast = down;
  if (holdRate() !== before) applyShiftSpeed();
}

// Phím trong cửa sổ video: bắt ở pha capture và chặn phím tắt sẵn có của thẻ <video>
// (nếu không, bấm chuột vào video rồi bấm Space sẽ bị xử lý 2 lần: dừng rồi chạy lại ngay).
function onVideoKey(e) {
  if (!isOpen('#videoModal') || isOpen('#lightbox') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches('input, textarea, select, [contenteditable]')) return;
  const el = $('#vmVideo'), k = e.key, lk = k.toLowerCase();
  if (k === ' ') { if (!e.repeat) { if (el.paused) el.play().catch(() => {}); else el.pause(); } }
  else if (k === 'ArrowLeft') seekBy(-SEEK_STEP);
  else if (k === 'ArrowRight') seekBy(SEEK_STEP);
  else if (lk === 'c') vmAddToCart();
  else if (lk === 's' && S.task !== 'trake') vmSubmit();
  else if (lk === 'g') { setVmTab('calc'); $('#vmGoto').focus(); }
  else if (k.length === 1 && '1234'.includes(k)) { const r = [0.5, 1, 1.5, 2][+k - 1]; $('#vmSpeed').value = String(r); if (!shiftFast) setRate(el, r); }
  else return;
  e.preventDefault(); e.stopPropagation();
}

// Gõ số frame trong cửa sổ video → nhảy tới đó (dừng lại để xem đúng frame).
async function vmGotoFrame() {
  const inp = $('#vmGoto'), raw = inp.value.trim().replace(/^[#f]/i, ''), f = Number(raw);
  if (!raw || !Number.isSafeInteger(f) || f < 0) { toast('Gõ số frame (số nguyên ≥ 0) rồi Enter.', 'error'); return; }
  await fpsReady();
  const fps = fpsOf(VM.v);
  if (!fps) { toast('Chưa có FPS của video này nên chưa nhảy tới frame được.', 'error'); return; }
  const el = $('#vmVideo'), t = f / fps + 0.001; // +1ms: rơi đúng vào frame f, không lệch về frame trước
  if (el.duration && t > el.duration) { toast(`${VM.v} chỉ có khoảng ${Math.floor(el.duration * fps)} frame.`, 'error'); return; }
  el.pause();
  el.currentTime = t;
  inp.value = ''; inp.blur();
}

// Snap ảnh thumbnail về keyframe gần nhất (ảnh chỉ có trên lưới keyframe).
async function nearestKeyframe(v, f) {
  try {
    const list = await Promise.race([timeline(v, 'all'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
    let best = null;
    for (const x of list) if (best === null || Math.abs(x.f - f) < Math.abs(best - f)) best = x.f;
    return best ?? f;
  } catch { return f; }
}
async function currentVideoItem() {
  await fpsReady();
  const f = vmFrame();
  if (f === null) { toast('Chưa lấy được FPS từ backend (/api/video-fps) — kiểm tra chấm ● API rồi thử lại.', 'error'); return null; }
  const el = $('#vmVideo');
  const it = itemOf(VM.v, f, el.currentTime);
  const kf = await nearestKeyframe(VM.v, f);
  it.src = frameUrl(VM.v, kf);
  it.thumbFrame = kf;
  return it;
}
async function vmAddToCart() {
  const it = await currentVideoItem();
  if (it) { addToCart(it); toast(`Đã thêm ${it.label} @ ${fmtTime(it.t, true)}`, 'success'); }
}
async function vmSubmit() {
  const it = await currentVideoItem();
  if (!it) return;
  if (S.task === 'vqa') {
    const ans = $('#vmAnswer').value.trim();
    if (!ans) { toast('Nhập câu trả lời Q&A trước khi nộp.', 'error'); $('#vmAnswer').focus(); return; }
    S.answers[it.key] = ans;
  }
  submitDres(it, false);
}

function inspectorItems() {
  const d = TX.data.get(VM.v);
  if (!d) return null;
  return [...d.ocr, ...d.asr].sort((a, b) => a.t - b.t);
}
function renderInspector() {
  const list = $('#inspList'), all = inspectorItems();
  const q = $('#inspQuery').value, terms = q.split(',').map(norm).filter(Boolean);
  const counts = { all: all?.length || 0, ocr: all?.filter(x => x.src === 'ocr').length || 0, asr: all?.filter(x => x.src === 'asr').length || 0 };
  $$('#inspTabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.f === VM.insp);
    b.textContent = { all: 'Tất cả', ocr: '🔤 OCR', asr: '🎙 ASR' }[b.dataset.f] + ` (${counts[b.dataset.f]})`;
  });
  if (!all) { list.innerHTML = '<li class="insp-empty">Đang tải OCR / ASR…</li>'; return; }
  const items = all.filter(x => (VM.insp === 'all' || x.src === VM.insp) && (!terms.length || terms.some(t => x.n.includes(t))));
  if (!items.length) { list.innerHTML = `<li class="insp-empty">${terms.length ? `Không có đoạn nào khớp “${esc(q)}”.` : 'Video này chưa có OCR / ASR.'}</li>`; return; }
  const fps = fps25(VM.v);
  list.innerHTML = items.slice(0, 1500).map(x => `<li class="insp-item" data-t="${x.t}">
    <div class="insp-top"><span class="src ${x.src}">${x.src === 'ocr' ? '🔤 OCR' : '🎙 ASR'}</span><span class="time">⏱ ${fmtTime(x.t, true)}</span><span class="muted">frame ${x.frame ?? Math.round(x.t * fps)}</span></div>
    <div class="txt">${hl(x.text, terms)}</div></li>`).join('');
  markInspectorNow($('#vmVideo').currentTime, true);
}
let lastNowMark = 0;
function markInspectorNow(ct, force = false) {
  const now = performance.now();
  if (!force && now - lastNowMark < 400) return;
  lastNowMark = now;
  const items = $$('#inspList .insp-item');
  let cur = null;
  for (const li of items) { if (+li.dataset.t <= ct + 0.05) cur = li; else break; }
  items.forEach(li => li.classList.toggle('now', li === cur));
  const list = $('#inspList');
  if (cur && !list.matches(':hover')) {
    const top = cur.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 60) list.scrollTop = top - 60;
  }
}

/* ════════════════════ 10. Frame strip (chuột phải) ════════════════════ */
const FS = { v: null, view: 'boundaries', frames: [], cur: null, cache: new Map() };
async function timeline(v, view) {
  const key = `${v}:${view}`;
  if (FS.cache.has(key)) return FS.cache.get(key);
  const p = api(`/api/videos/${enc(v)}/frames?view=${view}`).then(env => {
    const list = (env.data || []).map(x => ({ f: Number(x.frame_id), t: Number(x.timestamp_seconds) })).filter(x => Number.isFinite(x.f));
    if (!list.length) throw new Error('không có frame');
    return list;
  });
  FS.cache.set(key, p);
  p.catch(() => FS.cache.delete(key));
  return p;
}
async function openStrip(v, frame, view = FS.view) {
  hoverStop();
  $('#strip').hidden = false;
  document.body.classList.add('strip-open');
  $('#stripTitle').textContent = `${v} · đang tải…`;
  try {
    FS.frames = await timeline(v, view);
  } catch (e) {
    if (view === 'boundaries') return openStrip(v, frame, 'all');
    toast(`Không tải được dải frame của ${v}: ${e.message}`, 'error');
    closeStrip();
    return;
  }
  FS.v = v; FS.view = view;
  const f = Number(frame);
  FS.cur = FS.frames.reduce((b, x) => (Math.abs(x.f - f) < Math.abs(b.f - f) ? x : b), FS.frames[0]).f;
  renderStrip();
}
function renderStrip() {
  const idx = FS.frames.findIndex(x => x.f === FS.cur);
  const slice = FS.frames.slice(Math.max(0, idx - 20), idx + 21);
  $('#stripTitle').textContent = `${FS.v} · frame ${FS.cur} · ${idx + 1}/${FS.frames.length}`;
  $('#stripView').textContent = FS.view === 'boundaries' ? 'Chi tiết scene' : 'Chỉ biên scene';
  if (!$('#pvRight').hidden) { const x = stripCur(); if (x) pvShow('right', stripItem(x)); } // khung xem lớn đi theo frame đang chọn
  $('#stripFrames').innerHTML = slice.map(x => `<div class="sf${x.f === FS.cur ? ' cur' : ''}" data-f="${x.f}" data-t="${x.t}" draggable="true">
    ${imgTag(FS.v, x.f)}<div><span>${x.f}</span><span>${fmtTime(x.t, true)}</span></div></div>`).join('');
  $('#stripFrames .cur')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}
function stripNav(d) {
  const idx = FS.frames.findIndex(x => x.f === FS.cur);
  const n = idx + d;
  if (n < 0 || n >= FS.frames.length) return;
  FS.cur = FS.frames[n].f;
  renderStrip();
}
const stripCur = () => FS.frames.find(x => x.f === FS.cur);
const stripItem = x => itemOf(FS.v, x.f, x.t);
function closeStrip() { $('#strip').hidden = true; document.body.classList.remove('strip-open'); }
function bindStrip() {
  const box = $('#stripFrames');
  const at = e => { const el = e.target.closest('.sf'); return el ? FS.frames.find(x => x.f === +el.dataset.f) : null; };
  box.addEventListener('click', e => { const x = at(e); if (x) { FS.cur = x.f; renderStrip(); } });
  box.addEventListener('dblclick', e => { const x = at(e); if (x) openLightbox(FS.frames.map(stripItem), FS.frames.indexOf(x), 'strip'); });
  box.addEventListener('contextmenu', e => { const x = at(e); if (x) { e.preventDefault(); openVideo(FS.v, x.t); } });
  box.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  box.addEventListener('auxclick', e => { const x = at(e); if (x && e.button === 1) addToCart(stripItem(x)); });
  box.addEventListener('dragstart', e => { const x = at(e); if (x) startDrag(e, stripItem(x)); });
  $('#stripPrev').onclick = () => stripNav(-1);
  $('#stripNext').onclick = () => stripNav(1);
  $('#stripView').onclick = () => openStrip(FS.v, FS.cur, FS.view === 'boundaries' ? 'all' : 'boundaries');
  $('#stripBig').onclick = () => { const x = stripCur(); if (x) pvShow('right', stripItem(x)); };
  $('#stripHide').onclick = () => pvHide('right');
  $('#stripAdd').onclick = () => { const x = stripCur(); if (x) addToCart(stripItem(x)); };
  $('#stripPlay').onclick = () => { const x = stripCur(); if (x) openVideo(FS.v, x.t); };
  $('#stripClose').onclick = closeStrip;
}

/* ════════════════════ 10b. Preview như bản cũ ════════════════════
 * Trái: ảnh đang trỏ khi giữ Alt (hoặc bật chế độ preview bằng Alt+X).
 * Phải: frame đang chọn trong dải keyframe (↑ hiện · ↓ ẩn). Đúp chuột → toàn màn hình. */
const PV = { alt: false, mode: false, left: null, right: null };
function pvShow(side, it) {
  const box = side === 'left' ? $('#pvLeft') : $('#pvRight');
  PV[side] = it;
  const img = box.querySelector('img');
  img.dataset.v = it.video_id; img.dataset.f = it.thumbFrame ?? it.frame_id; delete img.dataset.fb;
  if (img.getAttribute('src') !== it.src) img.src = it.src;
  box.querySelector('.pv-cap').textContent = `${it.label} · ${fmtTime(it.t, true)}${it.pos ? ` · #${it.pos}` : ''}`;
  box.hidden = false; $('#preview').hidden = false;
}
function pvHide(side) {
  (side === 'left' ? $('#pvLeft') : $('#pvRight')).hidden = true;
  PV[side] = null;
  $('#preview').hidden = $('#pvLeft').hidden && $('#pvRight').hidden;
}
const pvHideAll = () => { pvHide('left'); pvHide('right'); };
function togglePreviewMode() {
  PV.mode = !PV.mode;
  toast(`Chế độ preview (di chuột để xem lớn): ${PV.mode ? 'BẬT' : 'TẮT'}`);
  if (PV.mode && HP.card) pvFromCard(HP.card);
}
function pvFromCard(card) {
  const r = S.results[+card.dataset.i];
  if (r) pvShow('left', { ...itemFromResult(r), pos: +card.dataset.i + 1 });
}
function bindPreview() {
  for (const side of ['left', 'right']) {
    const box = side === 'left' ? $('#pvLeft') : $('#pvRight'), img = box.querySelector('img');
    box.querySelector('.pv-x').onclick = () => pvHide(side);
    img.addEventListener('dblclick', () => {
      if (side === 'left' && PV.left) openLightbox(S.results.map(itemFromResult), (PV.left.pos || 1) - 1, 'results');
      else if (PV.right) { const i = FS.frames.findIndex(x => x.f === PV.right.frame_id); openLightbox(FS.frames.map(stripItem), Math.max(0, i), 'strip'); }
    });
    img.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    img.addEventListener('auxclick', e => { if (e.button === 1 && PV[side]) addToCart(PV[side]); });
    img.addEventListener('dragstart', e => { if (PV[side]) startDrag(e, PV[side]); });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Alt') { PV.alt = true; e.preventDefault(); if (HP.card) pvFromCard(HP.card); } });
  document.addEventListener('keyup', e => { if (e.key === 'Alt') { PV.alt = false; e.preventDefault(); } });
  window.addEventListener('blur', () => { PV.alt = false; });
}

/* ════════════════════ 11. Lightbox (xem lớn) ════════════════════ */
const LB = { list: [], i: 0, from: '' };
function openLightbox(list, i, from) {
  if (!list.length) return;
  hoverStop();
  LB.list = list; LB.i = Math.max(0, Math.min(list.length - 1, i)); LB.from = from;
  lbShow();
  openOverlay('#lightbox');
}
function lbShow() {
  const it = LB.list[LB.i];
  const img = $('#lbImg');
  img.dataset.v = it.video_id; img.dataset.f = it.thumbFrame ?? it.frame_id; delete img.dataset.fb;
  img.src = it.src;
  $('#lbCap').textContent = `${it.label} · ${fmtTime(it.t, true)} · ${LB.i + 1}/${LB.list.length}`;
  if (LB.from === 'strip' && FS.v === it.video_id) { FS.cur = it.frame_id; renderStrip(); }
}
function lbNav(d) { const n = LB.i + d; if (n >= 0 && n < LB.list.length) { LB.i = n; lbShow(); } }

/* ════════════════════ 12. Danh sách nộp (export area) ════════════════════ */
function addToCart(it, broadcast = true, quiet = false, at = null) {
  if (!it || !it.key) return;
  if (S.cart.some(c => c.key === it.key)) { if (!quiet) { toast(`${it.label} đã có trong danh sách nộp.`); openCart(true); } return; }
  if (at === null || at >= S.cart.length) S.cart.push(it); else S.cart.splice(Math.max(0, at), 0, it); // at: thả vào đúng vị trí
  openCart(true);
  renderCart();
  if (broadcast) queueSend('ADD_FRAME', toQueueItem(it));
}
function removeFromCart(key, broadcast = true) {
  const it = S.cart.find(c => c.key === key);
  S.cart = S.cart.filter(c => c.key !== key);
  renderCart();
  if (it && broadcast) queueSend('REMOVE_FRAME', { id: it.key });
}
function clearCart(broadcast = true) {
  S.cart = [];
  renderCart();
  if (broadcast) queueSend('CLEAR_QUEUE');
}
function moveTo(from, to) { // kéo thả: to = vị trí chèn (0…length) tính trên danh sách trước khi kéo
  if (from < 0 || from >= S.cart.length || to === from || to === from + 1) return;
  const [it] = S.cart.splice(from, 1);
  S.cart.splice(to > from ? to - 1 : to, 0, it);
  renderCart();
}
function moveCart(i, d) {
  const j = i + d;
  if (j < 0 || j >= S.cart.length) return;
  [S.cart[i], S.cart[j]] = [S.cart[j], S.cart[i]];
  renderCart();
}
function openCart(force) {
  const on = force ?? !document.body.classList.contains('cart-open');
  document.body.classList.toggle('cart-open', on);
}
function renderCart() {
  $('#cartCount').textContent = S.cart.length;
  const t = S.task;
  $('#cartSubmit').textContent = t === 'trake' ? `✅ Nộp bài — chuỗi TRAKE (${S.cart.length} frame)` : `✅ Nộp bài — mục #1 (${t === 'kis' ? 'KIS/VKIS' : 'Q&A'})`;
  const list = $('#cartList');
  if (!S.cart.length) {
    list.innerHTML = '<div class="cart-empty">Kéo thả frame vào đây<br>hoặc bấm + / chuột giữa trên ảnh<br>hoặc “Add to Answer” trong cửa sổ video.<br><br>Mục <b>#1</b> là mục được nộp khi bấm Nộp bài.</div>';
  } else {
    list.innerHTML = S.cart.map((it, i) => `<div class="citem" data-i="${i}" draggable="true" title="Kéo thả để đổi thứ tự">
      <span class="rank">${t === 'trake' ? `E${i + 1}` : i + 1}</span>
      <img data-v="${esc(it.video_id)}" data-f="${it.thumbFrame ?? it.frame_id}" src="${esc(it.src)}" title="Click: mở video · Chuột phải: frame lân cận" draggable="false" alt="">
      <div class="cm"><b title="${esc(it.label)}">${esc(it.label)}</b><span class="muted">⏱ ${fmtTime(it.t, true)}</span>
        ${t === 'vqa' ? `<input class="qa" data-k="${esc(it.key)}" value="${esc(S.answers[it.key] || '')}" placeholder="Câu trả lời…" maxlength="100">` : ''}</div>
      <div class="ca"><button data-c="up" title="Lên">↑</button><button data-c="down" title="Xuống">↓</button>
        ${t === 'trake' ? '' : '<button data-c="submit" title="Nộp DRES mục này">🚀</button>'}<button data-c="del" title="Xóa">✕</button></div></div>`).join('');
  }
  const keys = new Set(S.cart.map(c => c.key));
  $$('#results .card-f').forEach(c => { const r = S.results[+c.dataset.i]; if (r) c.classList.toggle('in-cart', keys.has(`${r.video_id}/${r.frame_id}`)); });
  $('#trakeManual').hidden = t !== 'trake';
  const u = S.trakeUndo, undo = $('#cartUndo');
  undo.hidden = !(t === 'trake' && u?.items?.length);
  if (!undo.hidden) {
    undo.textContent = `↩ Quay lại lần nộp trước (${u.items.length} frame · ${new Date(u.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    undo.title = `Lấy lại các ứng viên có trong danh sách lúc nộp: ${u.label || ''}`;
  }
}

/* ── TRAKE: nộp xong (đúng hay sai) thì dọn danh sách, giữ bản cũ để bấm “↩ Quay lại” ── */
function snapshotTrake(label) {
  if (!S.cart.length) return; // danh sách đang trống (vd nộp tay): giữ bản lưu trước đó
  S.trakeUndo = { items: S.cart.map(it => ({ ...it })), label, at: Date.now() };
  store.set('aicTrakeUndo', JSON.stringify(S.trakeUndo));
}
function restoreTrake() {
  const u = S.trakeUndo;
  if (!u?.items?.length) return;
  const cur = S.cart.slice(), keys = new Set(u.items.map(i => i.key));
  S.cart = [...u.items, ...cur.filter(c => !keys.has(c.key))]; // mục mới thêm sau khi nộp vẫn giữ, xếp sau
  u.items.filter(i => !cur.some(c => c.key === i.key)).forEach(i => queueSend('ADD_FRAME', toQueueItem(i)));
  S.trakeUndo = null; store.del('aicTrakeUndo');
  openCart(true); renderCart();
  toast(`Đã lấy lại ${u.items.length} ứng viên như trước lần nộp${u.label ? ` ${u.label}` : ''}.`, 'success');
}

/* ── TRAKE nộp tay: gõ Video ID + các frame ── */
function parseFrames(s) {
  const fs = String(s || '').split(/[\s,;]+/).filter(Boolean).map(Number);
  return fs.length && fs.every(f => Number.isSafeInteger(f) && f >= 0) ? fs : null;
}
function tmPreview() {
  const raw = $('#tmVideo').value.trim(), fr = $('#tmFrames').value.trim(), el = $('#tmPreview');
  const v = raw.replace(/\.(mp4|mov|mkv|webm|avi|m4v)$/i, '').toUpperCase(), fs = parseFrames(fr);
  el.classList.remove('bad');
  if (!raw && !fr) { el.textContent = 'Frame cách nhau bằng dấu phẩy, đúng thứ tự sự kiện.'; return; }
  if (!fs) { el.textContent = fr ? 'Frame phải là số nguyên ≥ 0, cách nhau bằng dấu phẩy.' : `→ TR-${v ? dresVid(v) : '?'}-…`; el.classList.toggle('bad', Boolean(fr)); return; }
  el.textContent = `→ TR-${v ? dresVid(v) : '?'}-${fs.join(',')}${fs.some((f, i) => i && f <= fs[i - 1]) ? '   ⚠ frame chưa tăng dần' : ''}`;
  el.classList.toggle('bad', !v);
}
async function tmResolve() {
  const raw = $('#tmVideo').value.trim(), fs = parseFrames($('#tmFrames').value);
  if (!raw) { toast('Nhập Video ID.', 'error'); $('#tmVideo').focus(); return null; }
  if (!fs) { toast('Nhập các frame: số nguyên ≥ 0, cách nhau bằng dấu phẩy.', 'error'); $('#tmFrames').focus(); return null; }
  const res = await resolveVideo(raw);
  if (!res.found) { toast(notFoundMsg(raw, res), 'error', 5000); $('#tmVideo').focus(); return null; }
  $('#tmVideo').value = res.id; tmPreview();
  return { v: res.id, fs };
}
async function tmSubmit() {
  if (!dresLoggedIn()) { toast('Chưa đăng nhập DRES / chưa chọn evaluation.', 'error'); openDres(); return; }
  const r = await tmResolve();
  if (!r) return;
  const text = `TR-${dresVid(r.v)}-${r.fs.join(',')}`;
  await sendDres({ answerSets: [{ answers: [{ text }] }] }, 'trake', text);
}
async function tmAdd() {
  const r = await tmResolve();
  if (!r) return;
  await fpsReady();
  for (const f of r.fs) {
    const it = itemOf(r.v, f, f / fps25(r.v));
    const kf = await nearestKeyframe(r.v, f);
    if (kf !== f) { it.thumbFrame = kf; it.src = frameUrl(r.v, kf); }
    addToCart(it, true, true);
  }
  toast(`Đã thêm ${r.fs.length} frame của ${r.v} vào danh sách nộp.`, 'success');
}

function bindCart() {
  const list = $('#cartList');
  list.addEventListener('click', e => {
    const row = e.target.closest('.citem'); if (!row) return;
    const i = +row.dataset.i, it = S.cart[i];
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'up') moveCart(i, -1);
    else if (c === 'down') moveCart(i, 1);
    else if (c === 'del') removeFromCart(it.key);
    else if (c === 'submit') submitDres(it, true);
    else if (e.target.tagName === 'IMG') openVideo(it.video_id, it.t);
  });
  list.addEventListener('contextmenu', e => {
    const row = e.target.closest('.citem'); if (!row || e.target.tagName !== 'IMG') return;
    e.preventDefault(); const it = S.cart[+row.dataset.i]; openStrip(it.video_id, it.thumbFrame ?? it.frame_id);
  });
  list.addEventListener('input', e => { if (e.target.classList.contains('qa')) S.answers[e.target.dataset.k] = e.target.value; });

  // Kéo thả để đổi thứ tự; frame kéo từ lưới vào thì chèn đúng chỗ thả.
  const CART_DRAG = 'text/x-cart-index';
  let dragFrom = -1;
  const rows = () => $$('#cartList .citem');
  const unmark = () => rows().forEach(r => r.classList.remove('drop-before', 'drop-after'));
  const dropAt = e => {
    const row = e.target.closest('.citem');
    if (!row) return { row: null, index: S.cart.length };
    const b = row.getBoundingClientRect();
    const after = document.body.classList.contains('cart-wide') ? e.clientX > b.left + b.width / 2 : e.clientY > b.top + b.height / 2;
    return { row, after, index: +row.dataset.i + (after ? 1 : 0) };
  };
  list.addEventListener('dragstart', e => {
    const row = e.target.closest('.citem');
    if (!row) return;
    if (e.target.closest('input')) { e.preventDefault(); return; } // đang bôi đen chữ trong ô trả lời Q&A
    dragFrom = +row.dataset.i;
    e.dataTransfer.setData(CART_DRAG, String(dragFrom));
    e.dataTransfer.effectAllowed = 'move';
    hoverStop();
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  list.addEventListener('dragover', e => {
    const types = [...e.dataTransfer.types];
    if (!types.includes(CART_DRAG) && !types.includes('application/json')) return;
    e.preventDefault();
    const p = dropAt(e);
    unmark();
    if (p.row) p.row.classList.add(p.after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', e => {
    const types = [...e.dataTransfer.types], p = dropAt(e);
    unmark(); cart.classList.remove('drag-over'); $('#btnCart').classList.remove('drop');
    if (types.includes(CART_DRAG)) { e.preventDefault(); e.stopPropagation(); moveTo(dragFrom, p.index); return; }
    if (types.includes('application/json')) {
      e.preventDefault(); e.stopPropagation();
      try { const it = JSON.parse(e.dataTransfer.getData('application/json')); if (it && it.key) addToCart(it, true, false, p.index); } catch { /* không phải frame */ }
    }
  });
  list.addEventListener('dragend', () => { dragFrom = -1; unmark(); rows().forEach(r => r.classList.remove('dragging')); });
  const cart = $('#cart');
  for (const el of [cart, $('#btnCart')]) {
    el.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer.types.includes(CART_DRAG)) return; cart.classList.add('drag-over'); $('#btnCart').classList.add('drop'); });
    el.addEventListener('dragleave', () => { cart.classList.remove('drag-over'); $('#btnCart').classList.remove('drop'); });
    el.addEventListener('drop', e => {
      e.preventDefault(); cart.classList.remove('drag-over'); $('#btnCart').classList.remove('drop');
      try { const it = JSON.parse(e.dataTransfer.getData('application/json')); if (it && it.key) addToCart(it); } catch { /* không phải frame */ }
    });
  }
}

/* ── Submit Frame thủ công ── */
function openManualSubmit() {
  $('#msVideoId').value = '';
  $('#msFrameId').value = '';
  $('#msAnswer').value = '';
  $('#msAnswerRow').style.display = S.task === 'vqa' ? 'block' : 'none';
  openOverlay('#manualSubmitModal');
  setTimeout(() => $('#msVideoId').focus(), 50);
}

function parseFrameInput(v, fInput) {
  const raw = String(fInput || '').trim();
  if (!raw) return null;
  if (raw.includes(':')) {
    const parts = raw.split(':').map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const sec = parts[0] * 60 + parts[1];
      const fps = fps25(v);
      return Math.round(sec * fps);
    }
  }
  const n = parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function getManualItem() {
  const vid = String($('#msVideoId').value || '').trim().toUpperCase();
  if (!vid) { toast('Vui lòng nhập Video ID.', 'error'); return null; }
  const fid = parseFrameInput(vid, $('#msFrameId').value);
  if (fid === null) { toast('Frame ID không hợp lệ (nhập số nguyên hoặc mm:ss).', 'error'); return null; }
  const fps = fps25(vid);
  const t = fid / fps;
  const it = {
    key: `${vid}/${fid}`,
    video_id: vid,
    frame_id: fid,
    t: t,
    label: `${vid} #${fid}`,
    src: frameUrl(vid, fid)
  };
  if (S.task === 'vqa') {
    const ans = String($('#msAnswer').value || '').trim();
    if (!ans) { toast('Vui lòng nhập câu trả lời cho Q&A.', 'error'); return null; }
    S.answers[it.key] = ans;
  }
  return it;
}

function bindManualSubmit() {
  $('#cartManual')?.addEventListener('click', openManualSubmit);
  $('#msBtnAdd')?.addEventListener('click', () => {
    const it = getManualItem();
    if (!it) return;
    addToCart(it);
    closeOverlay('#manualSubmitModal');
    toast(`Đã thêm ${it.label} vào danh sách nộp.`, 'success');
  });
  $('#msBtnSubmit')?.addEventListener('click', async () => {
    const it = getManualItem();
    if (!it) return;
    closeOverlay('#manualSubmitModal');
    await submitDres(it, false);
  });
  const msInputs = [$('#msVideoId'), $('#msFrameId'), $('#msAnswer')];
  msInputs.forEach(inp => {
    inp?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#msBtnSubmit')?.click();
      }
    });
  });
}

function startDrag(e, it) {
  e.dataTransfer.setData('application/json', JSON.stringify(it));
  e.dataTransfer.effectAllowed = 'copy';
  hoverStop();
  openCart(true);
}

/* ── CSV / SOLOAI (giữ nguyên định dạng & kiểm tra của frontend cũ) ── */
const suggestedName = () => `query-p3--${S.task === 'vqa' ? 'qa' : S.task}.csv`;
function normalizedCsvName(v) {
  const safe = (String(v || '').trim() || suggestedName()).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return safe.toLowerCase().endsWith('.csv') ? safe : `${safe}.csv`;
}
const csvField = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvAnswer = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
function exportItems() {
  const items = S.cart.slice(0, 100).map(x => ({ ...x }));
  const seen = new Set(items.map(x => x.key));
  // KIS: bù đủ 100 dòng từ kết quả đang hiển thị, xếp theo score.
  if (S.task === 'kis' && items.length < 100 && !S.trake) {
    [...S.results].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .filter(r => r?.video_id != null && r?.frame_id != null && !seen.has(`${r.video_id}/${r.frame_id}`))
      .slice(0, 100 - items.length).forEach(r => { seen.add(`${r.video_id}/${r.frame_id}`); items.push(itemFromResult(r)); });
  }
  return items;
}
function buildCsv() {
  const items = exportItems();
  if (!items.length) { toast('Chưa có frame nào để lưu/xuất.', 'error'); return null; }
  const valid = it => it.video_id && Number.isSafeInteger(it.frame_id) && it.frame_id >= 0;
  if (items.some(it => !valid(it))) { toast('Có frame_id không hợp lệ trong danh sách nộp.', 'error'); return null; }
  if (S.task === 'kis') return { task: 'kis', items, content: items.map(it => `${csvField(it.video_id)},${it.frame_id}`).join('\r\n') };
  if (S.task === 'vqa') {
    const rows = [];
    for (const it of items) {
      const a = String(S.answers[it.key] || '').trim();
      if (!a) { toast(`Chưa nhập câu trả lời cho ${it.label}.`, 'error'); return null; }
      if (a.length > 100) { toast(`Câu trả lời cho ${it.label} vượt quá 100 ký tự.`, 'error'); return null; }
      rows.push(`${csvField(it.video_id)},${it.frame_id},${csvAnswer(a)}`);
    }
    return { task: 'vqa', items, content: rows.join('\r\n') };
  }
  const expected = trakeEvents().length || Number($('#evCount').value) || 0;
  if (expected > 0 && items.length !== expected) { toast(`TRAKE cần đúng ${expected} frame theo số sự kiện (đang có ${items.length}).`, 'error'); return null; }
  const byVideo = new Map();
  items.forEach(it => { if (!byVideo.has(it.video_id)) byVideo.set(it.video_id, []); byVideo.get(it.video_id).push(it.frame_id); });
  return { task: 'trake', items, content: [...byVideo].map(([v, fs]) => [csvField(v), ...fs].join(',')).join('\r\n') };
}
function downloadText(content, name) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function openCsv() {
  $('#csvName').value = suggestedName();
  openOverlay('#csvModal');
  setTimeout(() => { $('#csvName').focus(); $('#csvName').select(); }, 50);
}
function csvDownload() {
  const p = buildCsv(); if (!p) return;
  const name = normalizedCsvName($('#csvName').value);
  downloadText(p.content, name);
  closeOverlay('#csvModal');
  toast(`Đã tải ${name}`, 'success');
}
let soloDir = null;
async function saveLocalSolo(name, content) {
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const dir = soloDir || await window.showDirectoryPicker({ mode: 'readwrite' });
      soloDir = dir;
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(content); await w.close();
      return `Đã lưu ${name} vào thư mục ${dir.name}.`;
    } catch (e) { soloDir = null; if (e?.name !== 'AbortError') console.warn('SOLOAI folder write failed', e); }
  }
  downloadText(content, name);
  return `Đã tạo ${name}; hãy đặt file vào thư mục SOLOAI.`;
}
async function csvSolo() {
  const p = buildCsv(); if (!p) return;
  const name = normalizedCsvName($('#csvName').value);
  const answers = p.task === 'vqa' ? p.items.map(it => String(S.answers[it.key] || '').trim()) : [];
  const payload = { query_filename: name, task: p.task, content: p.content, items: p.items.map(it => ({ video_id: dresVid(it.video_id), frame_id: it.frame_id })), answers, answer: answers.join(', ') };
  const btn = $('#csvSolo'); btn.disabled = true;
  try {
    if (CFG.soloaiServer) {
      try {
        const r = await fetch(`${CFG.backend}/api/submission/solo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          const saved = body?.data || body;
          closeOverlay('#csvModal');
          toast(`Đã lưu SOLOAI: ${saved?.output_filename || name}`, 'success');
          return;
        }
        if (![404, 405].includes(r.status)) { const b = await r.json().catch(() => ({})); toast(errText(b, r.status), 'error'); return; }
      } catch (e) { console.warn('SOLOAI server save unavailable, dùng lưu cục bộ', e); }
    }
    const msg = await saveLocalSolo(name, p.content);
    closeOverlay('#csvModal');
    toast(msg, 'success');
  } finally { btn.disabled = false; }
}

/* ════════════════════ 13. DRES — đúng hướng dẫn của BTC ════════════════════
 * B1  POST {DRES}/api/v2/login  {username, password}              → {id, username, role, sessionId}
 *     (hoặc dán sessionId lấy ở trang {DRES}/user)
 * B2  GET  {DRES}/api/v2/client/evaluation/list?session=<sessionId> → [{id, name, type, status}]
 * B3  POST {DRES}/api/v2/submit/{evaluationID}?session=<sessionId>
 *     KIS/VKIS {answerSets:[{answers:[{mediaItemName:<VIDEO_ID>, start:<ms>, end:<ms>}]}]}   (start = end)
 *     QA       {answerSets:[{answers:[{text:"QA-<ANSWER>-<VIDEO_ID>-<TIME(ms)>"}]}]}
 *     TRAKE    {answerSets:[{answers:[{text:"TR-<VIDEO_ID>-<FRAME_ID1>,<FRAME_ID2>,..."}]}]}
 * Gọi qua server.py (/dres/…) để tránh CORS / chứng chỉ tự ký; không có server.py thì gọi thẳng. */
const D = {
  base: normDresUrl(CFG.dres),
  session: store.get('aicDresSession'), evalId: store.get('aicDresEval'), evalName: store.get('aicDresEvalName', ''),
  user: store.get('aicDresUser', ''), evals: [], busy: false,
  sent: store.json('aicDresSent', {}),  // {evaluationId: {đáp án: thời điểm}} — chống nộp trùng
  log: store.json('aicDresLog', []),    // các lần nộp gần nhất
  confirmKey: null, confirmUntil: 0,
};
const dresLoggedIn = () => Boolean(D.session && D.evalId);
function saveDres() {
  const put = (k, v) => (v ? store.set(k, v) : store.del(k));
  put('aicDresSession', D.session); put('aicDresEval', D.evalId); put('aicDresEvalName', D.evalName);
  store.set('aicFinalDres', D.base); store.set('aicDresUser', D.user || '');
  const b = $('#btnDres');
  b.textContent = dresLoggedIn() ? '✅ DRES' : '🔑 DRES';
  b.title = dresLoggedIn() ? `DRES ${D.base} · ${D.user || 'session'} · ${D.evalName || D.evalId}` : 'Đăng nhập DRES';
}
async function dresCall(path, method = 'GET', body = null) {
  const opts = { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined };
  let res = null;
  if (HTTP_PAGE) {
    try {
      res = await fetch(`/dres${path}`, { ...opts, headers: { ...opts.headers, 'X-DRES-Base': D.base } });
      if (!res.headers.get('X-DRES-Relay')) res = null; // trang không chạy bằng server.py
    } catch { res = null; }
  }
  if (!res) {
    try { res = await fetch(D.base + path, opts); }
    catch { throw new Error(`Không gọi được DRES ${D.base} (sai địa chỉ, mất mạng hoặc bị chặn CORS — hãy mở trang qua server.py).`); }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status === false) throw new Error(data?.description || data?.error || data?.detail || `DRES HTTP ${res.status}`);
  return data;
}
async function dresLoadEvals() {
  const list = await dresCall(`/api/v2/client/evaluation/list?session=${enc(D.session)}`);
  D.evals = (Array.isArray(list) ? list : []).filter(x => x && x.id != null)
    .map(x => ({ id: String(x.id), name: x.name || String(x.id), type: x.type || '', status: x.status || '' }));
  const active = D.evals.filter(x => /ACTIVE|RUNNING/i.test(x.status));
  const pick = active.length === 1 ? active[0] : D.evals.length === 1 ? D.evals[0] : null;
  if (pick) setEvaluation(pick);
  else if (!D.evals.length) toast('Tài khoản chưa có evaluation nào — có thể nhập Evaluation ID tay.');
}
function setEvaluation(x) {
  D.evalId = String(x.id ?? x); D.evalName = x.name || '';
  saveDres(); dresSocketSend();
}
function renderDres() {
  const opt = x => `<option value="${esc(x.id)}" ${x.id === D.evalId ? 'selected' : ''}>${esc(x.name)} · ${esc(x.type)} · ${esc(x.status)}</option>`;
  $('#dresBody').innerHTML = `
    <div class="status ${dresLoggedIn() ? 'ok' : ''}">${dresLoggedIn()
      ? `✓ Sẵn sàng nộp — <b>${esc(D.user || 'session')}</b> · evaluation <b>${esc(D.evalName || D.evalId)}</b>`
      : D.session ? 'Đã có sessionId — chọn evaluation bên dưới.' : 'Chưa đăng nhập.'}</div>
    <label>Server DRES</label><input id="dUrl" value="${esc(D.base)}" placeholder="https://eventretrieval.one">
    <label>Cách 2 — đăng nhập bằng tài khoản đội</label>
    <div class="row"><input id="dUser" value="${esc(D.user)}" placeholder="username" autocomplete="username"><input id="dPass" type="password" placeholder="password" autocomplete="current-password"><button class="btn primary" id="dLogin">Đăng nhập</button></div>
    <label>Cách 1 — dán sessionId (xem ở ${esc(D.base)}/user)</label>
    <div class="row"><input id="dSession" value="${esc(D.session || '')}" placeholder="sessionId" spellcheck="false"><button class="btn" id="dSessionOk">Dùng</button></div>
    ${D.session ? `<label>Evaluation</label>
      <div class="row">${D.evals.length ? `<select id="dEval" style="flex:1">${D.evals.map(opt).join('')}</select><button class="btn primary" id="dEvalOk">Chọn</button>` : ''}<button class="btn" id="dEvalReload" title="Tải lại danh sách">↻</button></div>
      <div class="row"><input id="dEvalManual" value="${esc(D.evalId || '')}" placeholder="hoặc nhập Evaluation ID tay" spellcheck="false"><button class="btn" id="dEvalManualOk">Dùng ID</button></div>` : ''}
    ${D.log.length ? `<label>Đã nộp gần đây</label><div class="dres-log">${D.log.map(x => `<div><span class="muted">${new Date(x.t).toLocaleTimeString()}</span> <b>${esc(TASK_LABEL[x.task] || x.task)}</b> ${esc(x.label)} → <b>${esc(x.verdict)}</b></div>`).join('')}</div>` : ''}
    ${D.session ? '<div class="row end"><button class="btn danger sm" id="dLogout">Đăng xuất</button></div>' : ''}`;
  const syncUrl = () => {
    const u = normDresUrl($('#dUrl').value);
    if (u !== D.base) { D.session = null; D.evalId = null; D.evalName = ''; D.evals = []; } // session của host khác không dùng được
    D.base = u; saveDres();
  };
  const run = async (btn, fn) => {
    syncUrl();
    if (!D.base) { toast('Nhập địa chỉ server DRES.', 'error'); return; }
    btn.disabled = true;
    try {
      await fn();
      if (dresLoggedIn()) { toast(`DRES sẵn sàng: ${D.evalName || D.evalId}`, 'success'); closeOverlay('#dresModal'); return; }
    } catch (e) { toast(e.message, 'error', 5000); }
    renderDres();
  };
  $('#dUrl').addEventListener('change', () => { syncUrl(); renderDres(); });
  $('#dLogin').onclick = e => {
    const user = $('#dUser').value.trim(), pass = $('#dPass').value;
    if (!user || !pass) { toast('Nhập đủ username và password của đội.', 'error'); return; }
    run(e.currentTarget, async () => {
      const r = await dresCall('/api/v2/login', 'POST', { username: user, password: pass });
      if (!r.sessionId) throw new Error('DRES không trả về sessionId.');
      D.session = String(r.sessionId); D.user = r.username || user; D.evalId = null; saveDres();
      await dresLoadEvals();
    });
  };
  $('#dSessionOk').onclick = e => {
    const sid = $('#dSession').value.trim();
    if (!sid) { toast('Dán sessionId trước.', 'error'); return; }
    run(e.currentTarget, async () => { D.session = sid; D.evalId = null; saveDres(); await dresLoadEvals(); });
  };
  $('#dEvalReload')?.addEventListener('click', e => run(e.currentTarget, dresLoadEvals));
  $('#dEvalOk')?.addEventListener('click', () => { setEvaluation(D.evals.find(x => x.id === $('#dEval').value)); renderDres(); toast(`Đã chọn ${D.evalName}`, 'success'); });
  $('#dEvalManualOk')?.addEventListener('click', () => {
    const id = $('#dEvalManual').value.trim();
    if (!id) { toast('Nhập Evaluation ID.', 'error'); return; }
    setEvaluation(D.evals.find(x => x.id === id) || id); renderDres(); toast('Đã dùng Evaluation ID nhập tay.', 'success');
  });
  $('#dLogout')?.addEventListener('click', () => { D.session = null; D.evalId = null; D.evalName = ''; D.evals = []; saveDres(); renderDres(); toast('Đã đăng xuất DRES.'); });
}
function openDres() {
  renderDres(); openOverlay('#dresModal');
  if (D.session && !D.evals.length) dresLoadEvals().then(renderDres).catch(() => {});
}

// Thời điểm xuất hiện của frame trong video gốc, đơn vị ms.
const msOf = it => Math.round((it.frame_id * 1000) / fps25(it.video_id));
function formatTrakeAnswer(items) {
  if (!items.length) { toast('Chưa có frame TRAKE nào trong danh sách nộp.', 'error'); return null; }
  const v = items[0].video_id;
  if (items.some(it => it.video_id !== v)) { toast('TRAKE chỉ được nộp các frame cùng một video.', 'error'); return null; }
  const fs = items.map(it => it.frame_id);
  if (fs.some(f => !Number.isSafeInteger(f) || f < 0)) { toast('Frame TRAKE không hợp lệ.', 'error'); return null; }
  return `TR-${dresVid(v)}-${fs.join(',')}`;
}
// Nộp xong (DRES nhận bài, hoặc báo đội đã nộp đáp án này) thì mục đó được gỡ khỏi danh sách nộp của cả team.
async function submitDres(item = null, fromCart = true) {
  if (!dresLoggedIn()) { toast('Chưa đăng nhập DRES / chưa chọn evaluation.', 'error'); openDres(); return; }
  await fpsReady();
  if (!FPS && S.task !== 'trake') toast('Chưa lấy được FPS từ backend — tạm tính ms theo 25 fps.', 'error');
  let answer, label, removeKey = null;
  if (S.task === 'trake') {
    const text = formatTrakeAnswer(S.cart);
    if (!text) return;
    answer = { text }; label = text; removeKey = 'trake';
  } else {
    const it = item || S.cart[0];
    if (!it) { toast('Danh sách nộp đang trống.', 'error'); return; }
    const ms = msOf(it);
    if (S.task === 'kis') {
      answer = { mediaItemName: dresVid(it.video_id), start: ms, end: ms }; // KIS / VKIS: start = end
      label = `${it.video_id} @ ${ms}ms (frame ${it.frame_id})`;
    } else {
      const a = String(S.answers[it.key] || '').trim();
      if (!a) { toast(`Nhập câu trả lời cho ${it.label} trước khi nộp.`, 'error'); openCart(true); return; }
      answer = { text: `QA-${a}-${dresVid(it.video_id)}-${ms}` }; label = answer.text;
    }
    removeKey = it.key; // nộp xong (kể cả nộp từ cửa sổ video) thì gỡ frame này khỏi danh sách chung — không ai nộp lại được nữa
  }
  await sendDres({ answerSets: [{ answers: [answer] }] }, removeKey, label);
}
// Đáp án đã nộp: {evaluationId: {đáp án: {t, by}}} — chia sẻ cho cả team qua /ws/dres để không ai nộp trùng (DRES chặn trùng theo đội).
const sentInfo = v => (v && typeof v === 'object' ? v : { t: Number(v) || 0, by: '' }); // bản cũ chỉ lưu thời điểm
function markSent(key) {
  (D.sent[D.evalId] ||= {})[key] = { t: Date.now(), by: S.teamName || '' };
  store.set('aicDresSent', JSON.stringify(D.sent));
  dresSocketSend();
}
function mergeSent(shared) {
  if (!shared || typeof shared !== 'object') return;
  let changed = false;
  for (const [ev, map] of Object.entries(shared)) {
    if (!map || typeof map !== 'object') continue;
    const mine = (D.sent[ev] ||= {});
    for (const [k, v] of Object.entries(map)) if (!mine[k]) { mine[k] = sentInfo(v); changed = true; }
  }
  if (changed) store.set('aicDresSent', JSON.stringify(D.sent));
}
function sharedSent() { // chỉ gửi danh sách đáp án của evaluation hiện tại (và tối đa 100 mục gần nhất) để WebSocket nhẹ
  const map = D.sent[D.evalId];
  if (!map) return {};
  const entries = Object.entries(map).sort((a, b) => (sentInfo(b[1]).t) - (sentInfo(a[1]).t)).slice(0, 100);
  return { [D.evalId]: Object.fromEntries(entries) };
}
function afterSubmit(removeKey, label) {
  if (removeKey === 'trake') { snapshotTrake(label); clearCart(); }
  else if (removeKey) removeFromCart(removeKey);
}
async function sendDres(body, removeKey, label) {
  if (D.busy) { toast('Bài đang được gửi, chờ chút…'); return; }
  const key = JSON.stringify(body.answerSets), info = sentInfo(D.sent[D.evalId]?.[key]);
  if (info.t && !(D.confirmKey === key && Date.now() < D.confirmUntil)) {
    D.confirmKey = key; D.confirmUntil = Date.now() + 6000;
    const by = info.by ? ` bởi ${info.by}` : '';
    toast(`⚠️ Đáp án này đã nộp lúc ${new Date(info.t).toLocaleTimeString()}${by} — DRES chặn trùng theo đội. Bấm nộp lần nữa trong 6 giây nếu vẫn muốn gửi.`, 'error', 6000);
    return;
  }
  D.busy = true; D.confirmKey = null;
  const btns = $$('#btnSubmit, #cartSubmit, #vmSubmit, #twsSubmit'); btns.forEach(b => { b.disabled = true; });
  const task = S.task;
  try {
    const data = await dresCall(`/api/v2/submit/${enc(D.evalId)}?session=${enc(D.session)}`, 'POST', body);
    const verdict = data?.submission || data?.description || 'đã gửi';
    markSent(key);
    D.log = [{ t: Date.now(), task, label, verdict }, ...D.log].slice(0, 12);
    store.set('aicDresLog', JSON.stringify(D.log));
    afterSubmit(removeKey, label); // đúng, sai hay đang chờ chấm đều đã nộp xong
    if (verdict === 'CORRECT' || verdict === 'WRONG') {
      toast(verdict === 'CORRECT' ? `✅ Chính xác! ${label}` : `❌ Chưa chính xác. ${label}`, verdict === 'CORRECT' ? 'success big' : 'error big', 4500);
    } else toast(`Đã nộp ${label} — ${verdict}`, 'info', 4500);
  } catch (e) {
    if (/duplicate/i.test(e.message)) {
      // DRES chặn trùng theo đội: đáp án này bạn hoặc đồng đội đã nộp trước đó → coi như đã nộp, gỡ khỏi danh sách.
      markSent(key);
      D.log = [{ t: Date.now(), task, label, verdict: 'TRÙNG — DRES không chấm lại' }, ...D.log].slice(0, 12);
      store.set('aicDresLog', JSON.stringify(D.log));
      afterSubmit(removeKey, label);
      toast(`⚠️ DRES từ chối vì đội đã nộp đúng đáp án này trước đó (bạn hoặc đồng đội) — lần này không được chấm, không cần nộp lại. ${label}`, 'error', 7000);
    } else toast(`Lỗi khi nộp: ${e.message}`, 'error', 6000);
  } finally {
    D.busy = false; btns.forEach(b => { b.disabled = false; });
  }
}

/* ════════════════════ 14. Team sync (backend/team_sync.py) ════════════════════ */
const wsBase = () => CFG.backend.replace(/^http/, 'ws');
function clientId() {
  let id = null; try { id = sessionStorage.getItem('teamClientId'); } catch { /* ignore */ }
  if (!id) { id = 'c' + Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem('teamClientId', id); } catch { /* ignore */ } }
  return id;
}
// Kết nối WebSocket tự nối lại sau 3s.
function socket(path, onMsg, onOpen) {
  const s = { ws: null, send(obj) { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; } return false; } };
  const connect = () => {
    try { s.ws = new WebSocket(wsBase() + path); } catch { setTimeout(connect, 3000); return; }
    s.ws.onopen = () => onOpen?.();
    s.ws.onmessage = ev => { try { onMsg(JSON.parse(ev.data)); } catch { /* bỏ qua frame lỗi */ } };
    s.ws.onclose = () => setTimeout(connect, 3000);
    s.ws.onerror = () => { try { s.ws.close(); } catch { /* ignore */ } };
  };
  connect();
  return s;
}
const T = { roster: [], team: null, dres: null, queue: null, hist: null, trakeWs: null, applying: false, teamHistory: [] };

// Presence
function activitySummary() {
  const q = S.task === 'trake' ? trakeEvents()[0] : $('#query').value.trim();
  return q ? `Đang tìm: "${q.slice(0, 28)}"` : 'Đang rảnh';
}
function heartbeat() { if (S.teamName) T.team?.send({ type: 'heartbeat', name: S.teamName, status: activitySummary() }); }
function renderTeamBadge() {
  const online = T.roster.filter(m => m.online);
  $('#teamBadge').textContent = S.teamName ? `👥 ${S.teamName} · ${online.length} online` : '👥 Chưa chọn tên';
  $('#teamBadge').title = online.map(m => `${m.name}: ${m.status || ''}`).join('\n') || 'Bấm để đặt tên hiển thị cho team';
}

// Hàng đợi nộp dùng chung — giữ định dạng item của frontend cũ để tương thích.
const toQueueItem = it => ({ id: it.key, frameId: it.t, realFrameId: it.frame_id, src: it.src, frameInfo: it.label, thumbFrame: it.thumbFrame });
function fromQueueItem(q) {
  const key = String(q?.id || '');
  const slash = key.lastIndexOf('/');
  let v = slash > 0 ? key.slice(0, slash) : '', f = slash > 0 ? Number(key.slice(slash + 1).replace(/^f_/, '')) : NaN;
  if (!v || !Number.isSafeInteger(f)) {
    const lbl = String(q?.frameInfo || ''), d = lbl.lastIndexOf('-');
    v = d > 0 ? lbl.slice(0, d) : ''; f = Number(q?.realFrameId ?? lbl.slice(d + 1));
  }
  if (!v || !Number.isSafeInteger(f)) return null;
  const it = itemOf(v, f, q.frameId);
  if (q.src) it.src = q.src;
  if (q.thumbFrame != null) it.thumbFrame = q.thumbFrame;
  return it;
}
function queueSend(action, payload) { if (S.cartShare) T.queue?.send(payload === undefined ? { action } : { action, payload }); }
function onQueueMsg(msg) {
  if (!S.cartShare) return;
  if (msg.action === 'SYNC_QUEUE' && Array.isArray(msg.payload)) {
    // server lưu mới-nhất-trước → đảo lại để khớp thứ tự thêm vào
    S.cart = msg.payload.slice().reverse().map(fromQueueItem).filter(Boolean);
  } else if (msg.action === 'ADD_FRAME') {
    const it = fromQueueItem(msg.payload);
    if (it && !S.cart.some(c => c.key === it.key)) S.cart.push(it);
  } else if (msg.action === 'REMOVE_FRAME') {
    S.cart = S.cart.filter(c => c.key !== msg.payload?.id);
  } else if (msg.action === 'CLEAR_QUEUE') {
    S.cart = [];
  } else return;
  renderCart();
}
function dresSocketSend() { if (!T.applying && D.session && D.evalId) T.dres?.send({ action: 'UPDATE_DRES', payload: { sessionId: D.session, evaluationId: D.evalId, evaluationName: D.evalName, baseUrl: D.base, sent: sharedSent() } }); }

function initTeam() {
  T.team = socket('/ws/team', msg => { if (msg.type === 'roster') { T.roster = msg.members || []; renderTeamBadge(); } }, heartbeat);
  setInterval(heartbeat, 4000);
  const cid = clientId();
  T.dres = socket(`/ws/dres/${cid}`, msg => {
    if (msg.action === 'SYNC_DRES') mergeSent(msg.payload?.sent); // đáp án đồng đội đã nộp
    if (msg.action === 'SYNC_DRES' && msg.payload?.sessionId) {
      T.applying = true;
      D.session = msg.payload.sessionId; D.evalId = msg.payload.evaluationId; D.evalName = msg.payload.evaluationName || '';
      if (msg.payload.baseUrl) D.base = normDresUrl(msg.payload.baseUrl);
      saveDres(); T.applying = false;
    }
  });
  T.queue = socket(`/ws/queue/${cid}`, onQueueMsg);
  T.hist = socket(`/ws/history/${cid}`, msg => { if (msg.type === 'HISTORY_UPDATE') { T.teamHistory = Array.isArray(msg.payload) ? msg.payload : []; if (H.tab === 'team') renderHistory(); } });
  T.trakeWs = socket(`/ws/trake/${cid}`, onTrakeSync);
  renderTeamBadge();
}

/* ── TRAKE team workspace (/ws/trake) ── */
const TW = { state: { lockedVideoId: null, stages: [] }, collapsed: false, lastLocked: undefined, waiters: [] };
function onTrakeSync(msg) {
  if (msg.action !== 'SYNC_TRAKE' || !msg.payload) return;
  TW.state = msg.payload;
  // Lần đồng bộ đầu (vừa mở trang) chỉ hiện nút 🔒 trên thanh trên; khóa mới trong phiên thì tự mở workspace.
  if (TW.state.lockedVideoId !== TW.lastLocked) { TW.collapsed = TW.lastLocked === undefined; TW.lastLocked = TW.state.lockedVideoId; }
  TW.waiters.splice(0).forEach(fn => fn());
  renderTrakeWs();
}
// Gửi 1 action rồi chờ bản SYNC tiếp theo (tối đa 2s) — thay cho setTimeout đoán mò.
function trakeAct(action, payload = {}) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { TW.waiters = TW.waiters.filter(f => f !== done); resolve(); }, 2000);
    TW.waiters.push(done);
    if (!T.trakeWs?.send({ action, payload })) { TW.waiters = TW.waiters.filter(f => f !== done); clearTimeout(timer); toast('Mất kết nối team (WebSocket TRAKE).', 'error'); resolve(); }
  });
}
function requireName() {
  if (S.teamName) return true;
  toast('Đặt tên của bạn trước (⚙️ Cài đặt).', 'error');
  openSettings(true);
  return false;
}
async function makeTrakeKey(video) {
  if (!requireName()) return;
  const frames = [], times = [];
  (video.frame_ids || []).forEach((f, i) => { if (f !== null && f !== undefined) { frames.push(f); times.push(video.timestamps_seconds?.[i]); } });
  toast(`🔑 Khóa ${video.video_id} — tự căn ${frames.length} giai đoạn từ kết quả…`, 'success');
  await trakeAct('MAKE_KEY', { sourceFrame: { video: video.video_id }, madeBy: S.teamName });
  TW.collapsed = false; renderTrakeWs(); // mở workspace kể cả khi video này đã được khóa từ trước
  for (let i = 0; i < frames.length; i++) {
    await trakeAct('ADD_STAGE', { label: `S${i + 1}` });
    const stage = TW.state.stages[TW.state.stages.length - 1];
    if (!stage) continue;
    const t = Number.isFinite(Number(times[i])) ? Number(times[i]) : frames[i] / fps25(video.video_id);
    await trakeAct('PROPOSE_STAGE_FRAME', { stageId: stage.id, proposedBy: S.teamName, kind: 'time', timeMs: Math.round(t * 1000), videoId: video.video_id });
    const fresh = TW.state.stages.find(s => s.id === stage.id);
    const cand = fresh?.candidates?.[fresh.candidates.length - 1];
    if (cand) await trakeAct('LOCK_STAGE_FRAME', { stageId: stage.id, candidateId: cand.id });
  }
}
const fmtMs = ms => fmtTime((Number(ms) || 0) / 1000, true);
function parseTimeInput(text) {
  const s = String(text || '').trim(); if (!s) return null;
  if (s.includes(':')) { const [m, sec] = s.split(':').map(Number); return Number.isNaN(m) || Number.isNaN(sec) ? null : Math.round((m * 60 + sec) * 1000); }
  const sec = parseFloat(s); return Number.isNaN(sec) ? null : Math.round(sec * 1000);
}
function renderTrakeWs() {
  const el = $('#trakeWs'), st = TW.state, pill = $('#trakeLockPill');
  pill.hidden = !st.lockedVideoId;
  pill.textContent = st.lockedVideoId ? `🔒 TRAKE ${st.lockedVideoId}` : '';
  if (!st.lockedVideoId) { el.classList.remove('open'); el.innerHTML = ''; el.dataset.v = ''; return; }
  el.classList.toggle('open', !TW.collapsed);
  const stages = st.stages || [], locked = stages.filter(s => s.lockedCandidateId).length;
  const allLocked = stages.length > 0 && locked === stages.length;
  // Giữ nguyên <video> nếu vẫn cùng video để không bị giật khi team cập nhật.
  if (el.dataset.v !== st.lockedVideoId) {
    el.dataset.v = st.lockedVideoId;
    el.innerHTML = `<div class="tws-head"><b>🔒 ${esc(st.lockedVideoId)}</b><span class="muted" id="twsBy"></span>
        <button class="btn xs" id="twsUnlock">Mở khóa</button><button class="icon" id="twsClose" title="Thu gọn">✕</button></div>
      <video id="twsVideo" controls preload="metadata"></video>
      <div class="tws-stages" id="twsStages"></div>
      <div class="tws-foot"><button class="btn sm" id="twsAdd">＋ Thêm giai đoạn</button><button class="btn sm primary grow" id="twsSubmit"></button></div>`;
    setVideoSrc($('#twsVideo'), st.lockedVideoId, 0);
    $('#twsUnlock').onclick = () => trakeAct('UNLOCK_VIDEO');
    $('#twsClose').onclick = () => { TW.collapsed = true; el.classList.remove('open'); };
    $('#twsAdd').onclick = () => { if (requireName()) trakeAct('ADD_STAGE', {}); };
    $('#twsSubmit').onclick = submitTrakeChain;
    $('#twsStages').addEventListener('click', onStageClick);
  }
  $('#twsBy').textContent = st.lockedBy ? `bởi ${st.lockedBy}` : '';
  const sub = $('#twsSubmit');
  sub.disabled = !allLocked;
  sub.textContent = `🚀 Nộp DRES (${locked}/${stages.length} giai đoạn)`;
  sub.title = allLocked ? 'Nộp chuỗi TRAKE lên DRES' : 'Mỗi giai đoạn cần khóa 1 frame trước khi nộp';
  $('#twsStages').innerHTML = stages.map(s => {
    const lockedC = s.candidates.find(c => c.id === s.lockedCandidateId);
    const others = s.candidates.filter(c => c.id !== s.lockedCandidateId);
    return `<div class="stage${lockedC ? ' done' : ''}" data-s="${esc(s.id)}">
      <div class="stage-head"><span>${esc(s.label)}</span><button class="icon" data-a="delStage" title="Xóa giai đoạn">✕</button></div>
      ${lockedC ? `<div class="stage-lock">🔒 ${fmtMs(lockedC.timeMs)} · ${esc(lockedC.proposedBy)} · ${lockedC.votes.length} vote <button class="btn xs" data-a="seek" data-ms="${lockedC.timeMs}">▶</button></div>` : '<div class="muted">Chưa khóa frame.</div>'}
      ${others.map(c => `<div class="cand"><span>${fmtMs(c.timeMs)} · ${esc(c.proposedBy)} · ${c.votes.length} vote</span>
        <button class="btn xs" data-a="seek" data-ms="${c.timeMs}">▶</button><button class="btn xs" data-a="vote" data-c="${esc(c.id)}">Vote</button>
        <button class="btn xs primary" data-a="lock" data-c="${esc(c.id)}">Khóa</button><button class="btn xs" data-a="delCand" data-c="${esc(c.id)}">✕</button></div>`).join('')}
      <div class="row"><input placeholder="mm:ss hoặc giây" data-a="time"><button class="btn xs" data-a="propose">⏱ Đề xuất</button><button class="btn xs" data-a="current" title="Dùng thời điểm hiện tại của video">▶ Hiện tại</button></div>
    </div>`;
  }).join('') || '<div class="muted">Chưa có giai đoạn nào — bấm “＋ Thêm giai đoạn”.</div>';
}
function onStageClick(e) {
  const btn = e.target.closest('[data-a]'); if (!btn || btn.tagName === 'INPUT') return;
  const card = btn.closest('.stage'), stageId = card?.dataset.s, a = btn.dataset.a;
  const propose = ms => { if (ms !== null && requireName()) trakeAct('PROPOSE_STAGE_FRAME', { stageId, proposedBy: S.teamName, kind: 'time', timeMs: ms, videoId: TW.state.lockedVideoId }); };
  if (a === 'delStage') trakeAct('REMOVE_STAGE', { stageId });
  else if (a === 'vote') { if (requireName()) trakeAct('VOTE_STAGE_FRAME', { stageId, candidateId: btn.dataset.c, voter: S.teamName }); }
  else if (a === 'lock') trakeAct('LOCK_STAGE_FRAME', { stageId, candidateId: btn.dataset.c });
  else if (a === 'delCand') trakeAct('REMOVE_STAGE_FRAME', { stageId, candidateId: btn.dataset.c });
  else if (a === 'seek') { const v = $('#twsVideo'); v.currentTime = Number(btn.dataset.ms) / 1000; v.play().catch(() => {}); }
  else if (a === 'propose') propose(parseTimeInput(card.querySelector('[data-a="time"]').value));
  else if (a === 'current') propose(Math.round(($('#twsVideo')?.currentTime || 0) * 1000));
}
async function submitTrakeChain() {
  if (!dresLoggedIn()) { toast('Chưa đăng nhập DRES.', 'error'); openDres(); return; }
  const stages = TW.state.stages || [];
  if (!stages.length || !stages.every(s => s.lockedCandidateId)) { toast('Mỗi giai đoạn cần khóa 1 frame trước khi nộp.', 'error'); return; }
  await fpsReady();
  const fps = fpsOf(TW.state.lockedVideoId);
  if (!fps) { toast('Chưa lấy được FPS từ backend (/api/video-fps) — kiểm tra chấm ● API rồi thử lại.', 'error'); return; }
  const frames = stages.map(s => Math.round((Number(s.candidates.find(c => c.id === s.lockedCandidateId).timeMs) * fps) / 1000));
  const text = `TR-${dresVid(TW.state.lockedVideoId)}-${frames.join(',')}`;
  await sendDres({ answerSets: [{ answers: [{ text }] }] }, null, text);
}

/* ════════════════════ 15. Lịch sử truy vấn ════════════════════ */
const H = { tab: 'me', list: store.json('aicHistory', []) };
function addHistory(entry) {
  if (!entry.q) return;
  H.list = [{ ...entry, ts: Date.now() }, ...H.list.filter(x => !(x.q === entry.q && x.task === entry.task))].slice(0, 60);
  store.set('aicHistory', JSON.stringify(H.list));
  if (H.tab === 'me') renderHistory();
}
function renderHistory() {
  $$('#histTabs button').forEach(b => b.classList.toggle('active', b.dataset.h === H.tab));
  $('#histClear').hidden = H.tab !== 'me';
  const list = H.tab === 'me' ? H.list : T.teamHistory.filter(x => x && x.q);
  $('#histList').innerHTML = list.length ? list.map((x, i) => `<div class="hist-item" data-i="${i}" title="${esc(x.q)}">
      <span class="tag">${TASK_LABEL[x.task] || ''}</span><span class="q">${esc(x.q)}</span>
      ${H.tab === 'team' && x.by ? `<span class="muted">${esc(x.by)}</span>` : ''}
      <button class="icon" data-h="copy" title="Copy">📋</button>${H.tab === 'me' ? '<button class="icon" data-h="share" title="Chia sẻ cho team">↗</button>' : ''}</div>`).join('')
    : `<div class="hist-empty">${H.tab === 'me' ? 'Chưa có truy vấn nào.' : 'Team chưa chia sẻ truy vấn nào (bấm ↗ trên lịch sử của bạn).'}</div>`;
}
function useHistory(x) {
  if (!x) return;
  setTask(x.task || 'kis');
  if (x.task === 'trake') { const ev = x.events?.length ? x.events : splitEvents(x.q); renderEvents(ev.length, ev); }
  else $('#query').value = x.q;
  toast('Đã điền lại truy vấn — nhấn Enter để tìm.');
}
function bindHistory() {
  $('#histTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { H.tab = b.dataset.h; renderHistory(); } });
  $('#histClear').onclick = () => { H.list = []; store.set('aicHistory', '[]'); renderHistory(); };
  $('#histList').addEventListener('click', e => {
    const row = e.target.closest('.hist-item'); if (!row) return;
    const x = (H.tab === 'me' ? H.list : T.teamHistory.filter(y => y && y.q))[+row.dataset.i];
    const a = e.target.closest('[data-h]')?.dataset.h;
    if (a === 'copy') navigator.clipboard?.writeText(x.q).then(() => toast('Đã copy.', 'success', 1200));
    else if (a === 'share') { if (!requireName()) return; T.hist?.send({ action: 'ADD_HISTORY', payload: { q: x.q, task: x.task, events: x.events || null, by: S.teamName, ts: Date.now() } }) ? toast('Đã chia sẻ cho team.', 'success') : toast('Mất kết nối team.', 'error'); }
    else useHistory(x);
  });
}

/* ════════════════════ 16. Prefetch (không chặn hiển thị) ════════════════════ */
const PF = { vctl: null, warmed: new Set(), bctl: null, warmedImg: new Set() };
function distinctVideos(rows, limit) {
  const out = [];
  for (const r of rows || []) { const v = String(r?.video_id || ''); if (v && !out.some(x => x[0] === v)) out.push([v, Number(r.frame_id) || 0]); if (out.length >= limit) break; }
  return out;
}
function prefetchVideos(rows, limit) {
  // Khi dùng direct B2 URL, video element tự stream — không cần prefetch thủ công qua fetch().
  // fetch() với Range header trên URL backblazeb2.com sẽ bị CORS block (preflight không được hỗ trợ).
  if (window.B2_DL_AUTH) return;
  PF.vctl?.abort(); const ctl = PF.vctl = new AbortController();
  const queue = distinctVideos(rows, limit).map(x => x[0]).filter(v => !PF.warmed.has(v));
  const worker = async () => {
    while (queue.length && !ctl.signal.aborted) {
      const v = queue.shift();
      try {
        const url = videoUrl(v);
        if (url.includes('backblazeb2.com')) { PF.warmed.add(v); continue; } // B2 direct: skip
        const r = await fetch(url, { headers: { Range: 'bytes=0-2097151' }, cache: 'force-cache', signal: ctl.signal, priority: 'low' });
        if (r.ok || r.status === 206) { await r.arrayBuffer(); PF.warmed.add(v); }
        else if (r.status === 404 && url.includes('/media/videos/') && MEDIA.videos === null) { MEDIA.videos = false; queue.unshift(v); }
      } catch { /* bỏ qua */ }
    }
  };
  Promise.all([worker(), worker()]).catch(() => {});
}
function prefetchBoundaries(rows, limit, perVideo) {
  // Khi dùng direct B2, bỏ qua tải ngầm hàng trăm ảnh ranh giới cảnh để nhường toàn bộ băng thông
  // cho các ảnh kết quả tìm kiếm hiển thị trên màn hình tải nhanh nhất có thể.
  if (window.B2_DL_AUTH) return;
  PF.bctl?.abort(); const ctl = PF.bctl = new AbortController();
  const vids = distinctVideos(rows, limit), imgs = [];
  const tl = async () => {
    while (vids.length && !ctl.signal.aborted) {
      const [v, f] = vids.shift();
      try { (await timeline(v, 'boundaries')).slice().sort((a, b) => Math.abs(a.f - f) - Math.abs(b.f - f)).slice(0, perVideo).forEach(x => imgs.push([v, x.f])); } catch { /* bỏ qua */ }
    }
  };
  const im = async () => {
    while (imgs.length && !ctl.signal.aborted) {
      const [v, f] = imgs.shift(), k = `${v}:${f}`;
      if (PF.warmedImg.has(k)) continue;
      await new Promise(res => { const i = new Image(); i.onload = i.onerror = res; i.src = frameUrl(v, f); });
      PF.warmedImg.add(k);
    }
  };
  Promise.all([tl(), tl(), tl()]).then(() => Promise.all([im(), im(), im(), im()])).catch(() => {});
}

/* ════════════════════ 17. Health, cài đặt, phím tắt ════════════════════ */
const netMsg = e => (e instanceof TypeError ? `không kết nối được backend (${CFG.backend})` : e.message);
const CONN = { ok: null, err: '', kind: '', timer: 0 };
async function refreshHealth() {
  const dot = $('#health');
  clearTimeout(CONN.timer);
  try {
    let r;
    try { r = await fetch(`${CFG.backend}/health`, { cache: 'no-store' }); }
    catch { CONN.kind = 'network'; throw new Error('trình duyệt không gọi được địa chỉ này (sai địa chỉ/cổng, backend tắt, hoặc bị chặn CORS)'); }
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      CONN.kind = r.status === 502 && body ? 'proxy' : r.status === 404 && !body ? 'static' : 'http';
      throw new Error(body ? errText(body, r.status) : `HTTP ${r.status}`);
    }
    let extra = '';
    try { const s = await api('/api/stats'); if (s.data?.query_count != null) extra = ` — ${s.data.query_count} queries`; } catch { /* stats không bắt buộc */ }
    dot.className = 'dot ok'; dot.parentElement.title = dot.title = `API OK (${CFG.backend})${extra}`;
    if (CONN.ok === false) toast('Đã kết nối lại backend.', 'success');
    CONN.ok = true; CONN.err = '';
    if (!FPS) fpsReady();
  } catch (e) {
    dot.className = 'dot down'; dot.parentElement.title = dot.title = `API không phản hồi (${CFG.backend}): ${e.message}`;
    CONN.ok = false; CONN.err = e.message;
  }
  renderConnBanner();
  CONN.timer = setTimeout(refreshHealth, CONN.ok ? 30000 : 5000); // mất kết nối thì thử lại mỗi 5s
}
// Banner hướng dẫn khi chưa kết nối được backend (tự ẩn khi kết nối lại).
function renderConnBanner() {
  let el = $('#connBanner');
  if (CONN.ok !== false) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'connBanner';
    el.style.cssText = 'background:rgba(138,60,54,.35);border:1px solid #c0503f;border-radius:9px;padding:.6rem .85rem;font-size:.8rem;line-height:1.55;display:flex;gap:.7rem;align-items:flex-start';
    $('#content').prepend(el);
    el.addEventListener('click', e => { const a = e.target.closest('[data-conn]')?.dataset.conn; if (a === 'retry') refreshHealth(); if (a === 'settings') openSettings(); });
  }
  const viaPage = CFG.backend === location.origin;
  const hint = {
    static: 'Server đang phục vụ trang <b>không chuyển tiếp /api</b> (có thể là server.py bản cũ). Tắt nó rồi chạy lại <code>python server.py</code> trong thư mục aic_final_frontend.',
    proxy: 'server.py đang chạy nhưng <b>không tới được backend</b>. Mở lại SSH tunnel <code>ssh -L 8602:localhost:8602 &lt;user&gt;@&lt;server&gt;</code> và kiểm tra backend trên server đã chạy (<code>./run_backend_exp.sh 8602</code>). Tunnel dùng cổng khác thì chạy <code>python server.py --backend http://127.0.0.1:&lt;cổng&gt;</code>.',
    network: viaPage
      ? 'Không gọi được server của trang. Kiểm tra cửa sổ đang chạy <code>python server.py</code>.'
      : 'Trang đang gọi <b>thẳng</b> backend. Cách chắc chắn nhất: mở trang qua <code>python server.py</code> (http://localhost:8082) và để trống ô Backend trong ⚙️.',
    http: 'Backend trả lỗi — xem log của backend trên server.',
  }[CONN.kind] || '';
  el.innerHTML = `<span style="font-size:1.2rem">⚠️</span><div style="flex:1"><b>Chưa kết nối được backend</b> — đang gọi <code>${esc(CFG.backend)}</code><br>
    <span class="muted">${esc(CONN.err)}</span><br>${hint}</div>
    <div class="row"><button class="btn sm" data-conn="retry">↻ Thử lại</button><button class="btn sm" data-conn="settings">⚙️ Đổi địa chỉ</button></div>`;
}
// Thư mục video trên máy (server.py quét; lưu data/video_dirs.txt). Không chạy qua server.py → ẩn mục này.
let DIRS = null;
function renderDirs() {
  const box = $('#dirBox');
  box.hidden = !DIRS;
  if (!DIRS) return;
  $('#dirList').innerHTML = DIRS.dirs.map((d, i) => `<div class="dir-row${d.exists ? '' : ' bad'}" title="${esc(d.path)}">
      <span class="p">&lrm;${esc(d.path)}&lrm;</span>
      <span class="n">${d.exists ? `${d.videos} video${d.frame_dirs ? ` · ${d.frame_dirs} keyframe` : ''}` : 'không tìm thấy'}</span>
      ${d.removable ? `<button data-rm="${i}" title="Bỏ thư mục này">✕</button>` : `<span class="muted">${esc(d.source)}</span>`}</div>`).join('');
}
async function loadDirs() {
  try {
    const r = await fetch(`${CFG.media}/media/dirs`, { cache: 'no-store' });
    const d = r.ok ? await r.json() : null;
    DIRS = d && Array.isArray(d.dirs) ? d : null;
  } catch { DIRS = null; }
  renderDirs();
}
async function saveDirs(list, added = '') {
  const btn = $('#dirAddBtn'); btn.disabled = true;
  try {
    const r = await fetch(`${CFG.media}/media/dirs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dirs: list }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || `Không lưu được (HTTP ${r.status}).`, 'error', 6000); return false; }
    DIRS = d; renderDirs();
    const row = added && d.dirs.find(x => x.removable && x.path.toLowerCase() === added.toLowerCase());
    if (row) toast(row.videos ? `Đã thêm ${row.path} — ${row.videos} video.` : `Đã thêm ${row.path}, nhưng không thấy video nào bên trong (quét 5 cấp thư mục con).`, row.videos ? 'success' : 'error', 5000);
    else toast(`Đã lưu — tổng ${d.videos} video trên máy.`, 'success');
    return true;
  } catch (e) { toast(`Không lưu được: ${netMsg(e)}`, 'error'); return false; }
  finally { btn.disabled = false; }
}
async function addDir() {
  const input = $('#dirAdd');
  const path = input.value.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!path || !DIRS) return;
  const own = DIRS.dirs.filter(d => d.removable).map(d => d.path);
  if (DIRS.dirs.some(d => d.path.toLowerCase() === path.replace(/[\\/]+$/, '').toLowerCase())) { toast('Thư mục này đã có trong danh sách.', 'error'); return; }
  if (await saveDirs([...own, path], path.replace(/[\\/]+$/, '') || path)) input.value = '';
}
function openSettings(focusName = false) {
  loadDirs();
  $('#setName').value = S.teamName;
  $('#setBackend').value = store.get('aicFinalBackend', '') || '';
  $('#setBackend').placeholder = HTTP_PAGE ? `để trống = qua server.py (${location.origin})` : 'http://localhost:8602';
  openOverlay('#settingsModal');
  setTimeout(() => (focusName ? $('#setName') : $('#setBackend')).focus(), 50);
}
function saveSettings() {
  const name = $('#setName').value.trim(), backend = trimSlash($('#setBackend').value);
  const reload = backend !== (store.get('aicFinalBackend', '') || '');
  if (name) { S.teamName = name; store.set('teamMemberName', name); heartbeat(); renderTeamBadge(); }
  backend ? store.set('aicFinalBackend', backend) : store.del('aicFinalBackend');
  closeOverlay('#settingsModal');
  if (reload) {
    // Bỏ ?backend= trên URL để giá trị vừa lưu có hiệu lực.
    const u = new URL(location.href); u.searchParams.delete('backend');
    location.href = u.toString();
  } else toast('Đã lưu cài đặt.', 'success');
}
const HELP = [
  ['Tìm kiếm'],
  ['Enter', 'Tìm (trong ô truy vấn) · Shift+Enter xuống dòng'],
  ['Ctrl+Enter', 'Lọc frame tốt nhất trong các video đã “Chọn video”'],
  ['/', 'Về ô tìm kiếm'], ['1 · 2 · 3', 'Chuyển KIS · Q&A · TRAKE'],
  ['Alt+E', 'Bật/tắt dịch VI → EN'], ['Alt+W', 'Đổi xem lưới ↔ theo video'],
  ['Ctrl+Q', 'Reset ô truy vấn & chế độ'], ['Ctrl+E', 'Xóa nội dung các ô truy vấn'],
  ['Kết quả'],
  ['Click', 'Mở video tại frame'], ['Chuột phải', 'Dải keyframe lân cận'],
  ['Chuột giữa / kéo thả / +', 'Thêm vào danh sách nộp'],
  ['Giữ Alt + di chuột', 'Xem lớn ở khung preview (Alt+X: bật/tắt luôn)'],
  ['Di chuột', 'Phát video quanh frame (tắt bằng ▶ Hover)'], ['Space', 'Xem toàn màn hình ảnh đang trỏ'],
  ['Dải keyframe'],
  ['← →', 'Keyframe trước / sau'], ['↑ / ↓', 'Hiện / ẩn khung xem lớn'], ['=  hoặc Enter', 'Thêm frame đang chọn'],
  ['Chuột phải', 'Phát video tại frame'], ['Esc', 'Đóng dải keyframe'],
  ['Cửa sổ video'],
  ['Space', 'Phát / dừng'], ['← →', 'Lùi / tới 5 giây (từng frame: nút ◀ 1f / 1f ▶)'], ['Giữ Shift · Shift+Z', 'Chạy x1.5 · x2, nhả ra về tốc độ cũ (cả video khi rê chuột lên ảnh)'], ['C', 'Add to Answer (frame hiện tại)'],
  ['S', 'Nộp bài frame hiện tại'], ['1–4', 'Tốc độ 0.5x · 1x · 1.5x · 2x'], ['Kéo thanh tiêu đề', 'Di chuyển cửa sổ (đúp chuột: về giữa)'], ['G', 'Gõ số frame để nhảy tới (Enter)'],
  ['Xuất & nộp bài'],
  ['Kéo thả', 'Đổi thứ tự trong danh sách nộp (thả ảnh từ lưới vào đúng chỗ muốn chèn)'],
  ['TRAKE', 'Nộp chuỗi xong (đúng hay sai) → danh sách được dọn; ↩ Quay lại lần nộp trước để lấy lại · ✍ Nộp tay: gõ Video ID + frame'],
  ['Alt+A', 'Mở/đóng danh sách nộp'], ['Alt+M', 'Nộp bài thủ công (Modal)'], ['Alt+S', 'Xóa hết danh sách nộp'], ['Ctrl+S', 'Nộp bài mục #1 (TRAKE: cả chuỗi)'],
  ['Định dạng nộp'],
  ['KIS / VKIS', '{mediaItemName: <video>, start: <ms>, end: <ms>} — start = end'],
  ['QA', 'QA-<đáp án>-<video>-<ms>'], ['TRAKE', 'TR-<video>-<frame1>,<frame2>,…'],
];
function openHelp() {
  $('#helpBody').innerHTML = HELP.map(x => (x.length === 1 ? `<h4>${x[0]}</h4>` : `<span><kbd>${esc(x[0])}</kbd></span><span>${esc(x[1])}</span>`)).join('');
  openOverlay('#helpModal');
}

function clearTextareas() {
  $('#query').value = '';
  $$('#evList textarea').forEach(t => { t.value = ''; });
  toast('Đã xóa nội dung các ô truy vấn.');
}
function resetQuery() {
  $('#query').value = '';
  renderEvents(2, []);
  ['#anVideo', '#anFrame', '#anQuery'].forEach(s => { $(s).value = ''; });
  updateAnchorHint();
  S.family = 'standard'; S.fusion = 'late'; S.mm = 'only_visual'; renderMode();
  (S.task === 'trake' ? $('#evList textarea') : $('#query')).focus();
}

// Mở video nhanh: "L21_V001", "L21_V001 90", "L21_V001 1:30", "L21_V001 #2250" (frame).
async function quickOpen() {
  const raw = $('#quickVideo').value.trim();
  if (!raw) return;
  // "ID", "ID 90", "ID 1:30", "ID #2250" (frame). Phần sau không phải thời gian → cả chuỗi là Video ID (vd "N051 V001").
  const m = raw.match(/^([^\s:,#]+)(?:[\s:,]*(#|f\s*)?\s*([\d.:]+))?\s*$/i) || [raw, raw];
  const res = await resolveVideo(m[1]);
  if (!res.found) { toast(notFoundMsg(m[1], res), 'error', 5000); $('#quickVideo').select(); return; }
  const v = res.id;
  if (!m[3]) $('#quickVideo').value = v;
  let t = 0;
  if (m[3]) {
    if (m[2]) { await fpsReady(); t = Number(m[3]) / fps25(v); }
    else if (m[3].includes(':')) { const p = m[3].split(':').map(Number); t = p.reduce((a, x) => a * 60 + x, 0); }
    else t = Number(m[3]);
  }
  openVideo(v, Number.isFinite(t) ? t : 0);
}

function closeTop() {
  if (isOpen('#lightbox')) { closeOverlay('#lightbox'); return true; }
  for (const id of ['#manualSubmitModal', '#videoModal', '#dresModal', '#csvModal', '#settingsModal', '#helpModal']) if (isOpen(id)) { closeOverlay(id); return true; }
  if ($('#trakeWs').classList.contains('open')) { TW.collapsed = true; $('#trakeWs').classList.remove('open'); return true; }
  if (!$('#strip').hidden) { closeStrip(); return true; }
  if (!$('#preview').hidden) { pvHideAll(); return true; }
  return false;
}
function onKey(e) {
  const k = e.key, lk = k.toLowerCase();
  const typing = e.target.matches('input, textarea, select, [contenteditable]');
  if (k === 'Escape') { if (typing) e.target.blur(); else closeTop(); return; }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const map = {
      w: () => setView(S.view === 'grid' ? 'group' : 'grid'),
      e: () => { $('#translate').checked = !$('#translate').checked; store.set('translate-checkbox', $('#translate').checked ? 'true' : 'false'); toast(`Dịch VI → EN: ${$('#translate').checked ? 'BẬT' : 'TẮT'}`); },
      a: () => openCart(),
      s: () => { clearCart(); toast('Đã xóa hết danh sách nộp.'); },
      x: () => togglePreviewMode(),
      m: () => openManualSubmit()
    };
    if (map[lk]) { e.preventDefault(); map[lk](); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && lk === 's') { e.preventDefault(); submitDres(); return; }
  if ((e.ctrlKey || e.metaKey) && lk === 'q') { e.preventDefault(); resetQuery(); return; }
  if ((e.ctrlKey || e.metaKey) && lk === 'e') { e.preventDefault(); clearTextareas(); return; }
  if (typing || e.ctrlKey || e.metaKey) return;

  if (isOpen('#lightbox')) {
    if (k === 'ArrowLeft') lbNav(-1);
    else if (k === 'ArrowRight') lbNav(1);
    else if (k === '=' || k === 'Enter') addToCart(LB.list[LB.i]);
    else return;
    e.preventDefault(); return;
  }
  if (isOpen('#videoModal')) return; // phím của cửa sổ video: xem onVideoKey
  if ($$('.overlay.open').length) return;
  if (!$('#strip').hidden && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '=', 'Enter'].includes(k)) {
    e.preventDefault();
    if (k === 'ArrowLeft') stripNav(-1);
    else if (k === 'ArrowRight') stripNav(1);
    else if (k === 'ArrowUp') $('#stripBig').click();
    else if (k === 'ArrowDown') $('#stripHide').click();
    else $('#stripAdd').click();
    return;
  }
  if (k === '/') { e.preventDefault(); (S.task === 'trake' ? $('#evList textarea') : $('#query')).focus(); }
  else if (k === '?') { e.preventDefault(); openHelp(); }
  else if (k === ' ' && HP.card) { e.preventDefault(); openLightbox(S.results.map(itemFromResult), +HP.card.dataset.i, 'results'); }
  else if (k === '1' || k === '2' || k === '3') setTask(['kis', 'vqa', 'trake'][+k - 1]);
}

/* ════════════════════ 18. Khởi động ════════════════════ */
function init() {
  // Task & mode
  $('#taskTabs').addEventListener('click', e => { const b = e.target.closest('[data-task]'); if (b) setTask(b.dataset.task); });
  $('#familySeg').addEventListener('click', e => { const b = e.target.closest('[data-family]'); if (b) { S.family = b.dataset.family; renderMode(); } });
  $$('[data-fusion]').forEach(b => b.addEventListener('click', () => { S.fusion = b.dataset.fusion; renderMode(); }));
  $$('[data-mm]').forEach(b => b.addEventListener('click', () => { S.mm = b.dataset.mm; renderMode(); }));
  $$('[data-grow]').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.grow).classList.toggle('tall')));
  renderMode();

  // Truy vấn
  const enterSearch = e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); filterSelected(); }
    else if (!e.shiftKey) { e.preventDefault(); runSearch(); }
  };
  $('#query').addEventListener('keydown', enterSearch);
  $('#evList').addEventListener('keydown', enterSearch);
  $('#evList').addEventListener('paste', e => {
    const ta = e.target.closest('textarea'); if (!ta) return;
    const text = e.clipboardData?.getData('text') || '';
    const parts = splitEvents(text);
    if (parts.length < 2 || ta.value.trim()) return;
    e.preventDefault();
    const start = +ta.dataset.ev, vals = $$('#evList textarea').map(t => t.value);
    parts.forEach((p, i) => { vals[start + i] = p; });
    renderEvents(Math.max(vals.length, start + parts.length), vals);
    toast(`Đã tách thành ${parts.length} sự kiện.`, 'success');
  });
  renderEvents(2, []);
  $('#evDec').onclick = () => renderEvents(+$('#evCount').value - 1);
  $('#evInc').onclick = () => renderEvents(+$('#evCount').value + 1);
  $('#evCount').addEventListener('change', () => renderEvents(+$('#evCount').value));
  ['#anVideo', '#anFrame', '#anQuery'].forEach(s => $(s).addEventListener('input', updateAnchorHint));
  $('#anClear').onclick = () => { ['#anVideo', '#anFrame', '#anQuery'].forEach(s => { $(s).value = ''; }); updateAnchorHint(); };
  $('#anOpen').onclick = async () => {
    const typed = $('#anVideo').value.trim();
    if (typed) {
      const res = await resolveVideo(typed);
      if (!res.found) { toast(notFoundMsg(typed, res), 'error', 5000); return; }
      $('#anVideo').value = res.id; updateAnchorHint(); openVideo(res.id, 0); return;
    }
    if (!VM.v) { toast('Nhập Video ID hoặc mở một video trước.', 'error'); return; }
    await fpsReady();
    setTrakeAnchor(VM.v, vmFrame(), false);
  };
  updateAnchorHint();
  $('#translate').checked = store.get('translate-checkbox') !== 'false';
  $('#translate').addEventListener('change', () => store.set('translate-checkbox', $('#translate').checked ? 'true' : 'false'));
  $('#btnSearch').onclick = () => runSearch();
  $('#btnDeepseek').onclick = () => runSearch({ deepseek: true });
  $('#btnFilter').onclick = filterSelected;
  $('#btnRestore').onclick = restoreOriginal;

  // Kết quả & thanh công cụ
  bindResults();
  $('#viewToggle').addEventListener('change', e => setView(e.target.checked ? 'group' : 'grid'));
  $('#videoTab').onclick = () => setVideoPane($('#paneVideo').hidden);
  $('#vsOpen').onclick = openVideoService;
  ['#vsId', '#vsTime'].forEach(sel => $(sel).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); openVideoService(); } }));
  $('#vsId').value = store.get('video-service-last-id', '');
  $('#cartTabs').addEventListener('click', e => { const b = e.target.closest('[data-task]'); if (b) setTask(b.dataset.task); });
  $('#vmTabs').addEventListener('click', e => { const b = e.target.closest('[data-vt]'); if (b) setVmTab(b.dataset.vt); });
  bindVideoDrag();
  bindPreview();
  const size = store.get('aicCardSize2', '150');
  $('#cardSize').value = size; document.documentElement.style.setProperty('--card-min', `${size}px`);
  $('#cardSize').addEventListener('input', e => { document.documentElement.style.setProperty('--card-min', `${e.target.value}px`); store.set('aicCardSize2', e.target.value); });
  $('#hoverPlay').checked = S.hoverPlay;
  $('#hoverPlay').addEventListener('change', e => { S.hoverPlay = e.target.checked; store.set('aicHoverPlay', S.hoverPlay ? '1' : '0'); if (!S.hoverPlay) hoverStop(); });
  $('#txQuery').addEventListener('input', debounce(onTxInput, 200));
  $('#txSrc').addEventListener('change', e => { TX.src = e.target.value; applyTx(); });
  $('#txScope').addEventListener('change', e => { TX.scope = e.target.value; applyTx(); });
  $('#txOnly').addEventListener('change', e => { TX.only = e.target.checked; applyTx(); });
  $('#txShow').addEventListener('change', e => { TX.show = e.target.checked; onTxInput(); });
  $('#txClear').onclick = clearTx;
  $('#results').innerHTML = emptyHTML();

  // Video viewer
  const vid = $('#vmVideo');
  ['timeupdate', 'seeked', 'loadedmetadata'].forEach(ev => vid.addEventListener(ev, updateVmClock));
  $$('#videoModal [data-step]').forEach(b => b.addEventListener('click', () => stepVideo(+b.dataset.step)));
  $$('#videoModal [data-stepf]').forEach(b => b.addEventListener('click', () => stepFrames(+b.dataset.stepf)));
  $('#vmRestart').onclick = () => { vid.currentTime = VM.t0; };
  $('#vmSpeed').addEventListener('change', e => { if (!shiftFast) setRate(vid, Number(e.target.value)); e.target.blur(); }); // blur: ← → không đổi tốc độ nữa
  $('#vmAdd').onclick = vmAddToCart;
  $('#vmSubmit').onclick = vmSubmit;
  $('#vmStrip').onclick = async () => { await fpsReady(); openStrip(VM.v, vmFrame() ?? Math.round(vid.currentTime * 25)); closeOverlay('#videoModal'); };
  $('#vmAnchor').onclick = async () => { await fpsReady(); setTrakeAnchor(VM.v, vmFrame(), true); };
  $('#inspQuery').addEventListener('input', debounce(renderInspector, 200));
  $('#inspTabs').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { VM.insp = b.dataset.f; renderInspector(); } });
  $('#inspList').addEventListener('click', e => { const li = e.target.closest('.insp-item'); if (li) { vid.currentTime = +li.dataset.t; vid.play().catch(() => {}); } });

  // Overlay chung
  $$('.overlay').forEach(o => o.addEventListener('mousedown', e => { if (e.target === o) closeOverlay('#' + o.id); }));
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeOverlay('#' + b.closest('.overlay').id)));
  $('#lbPrev').onclick = () => lbNav(-1);
  $('#lbNext').onclick = () => lbNav(1);
  $('#lbAdd').onclick = () => addToCart(LB.list[LB.i]);
  $('#lbOpen').onclick = () => { const it = LB.list[LB.i]; closeOverlay('#lightbox'); openVideo(it.video_id, it.t); };

  // Strip, danh sách nộp, CSV, DRES
  bindStrip();
  bindCart();
  bindManualSubmit();
  $('#btnCart').onclick = () => openCart();
  $('#cartClose').onclick = () => openCart(false);
  $('#cartWide').onclick = () => document.body.classList.toggle('cart-wide');
  $('#cartClear').onclick = () => { if (S.cart.length) { clearCart(); toast('Đã xóa hết danh sách nộp.'); } };
  $('#cartCsv').onclick = openCsv;
  $('#cartSubmit').onclick = () => submitDres();
  $('#cartUndo').onclick = restoreTrake;
  $('#tmSubmit').onclick = tmSubmit;
  $('#tmAdd').onclick = tmAdd;
  ['#tmVideo', '#tmFrames'].forEach(sel => $(sel).addEventListener('input', tmPreview));
  $('#tmFrames').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tmSubmit(); } });
  $('#vmGoto').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); vmGotoFrame(); } });
  tmPreview();
  $('#btnSubmit').onclick = () => submitDres();
  const share = $('#cartShare');
  const renderShare = () => { share.classList.toggle('on', S.cartShare); share.title = `Chia sẻ danh sách với team: ${S.cartShare ? 'BẬT' : 'TẮT'}`; };
  share.onclick = () => { S.cartShare = !S.cartShare; store.set('aicCartShare', S.cartShare ? '1' : '0'); renderShare(); toast(S.cartShare ? 'Danh sách nộp đang chia sẻ với team.' : 'Danh sách nộp riêng (không chia sẻ).'); };
  renderShare();
  $('#csvDownload').onclick = csvDownload;
  $('#csvSolo').onclick = csvSolo;
  $('#csvName').addEventListener('keydown', e => { if (e.key === 'Enter') csvDownload(); });
  $('#btnDres').onclick = openDres;
  saveDres();

  // Header
  $('#quickGo').onclick = quickOpen;
  $('#quickVideo').value = store.get('video-service-last-id', '');
  $('#quickVideo').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); quickOpen(); } });
  $('#teamBadge').onclick = () => openSettings(true);
  $('#trakeLockPill').onclick = () => { TW.collapsed = false; renderTrakeWs(); };
  $('#btnSettings').onclick = () => openSettings();
  $('#setSave').onclick = saveSettings;
  $('#dirAddBtn').onclick = addDir;
  $('#dirAdd').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addDir(); } });
  $('#dirList').addEventListener('click', e => {
    const i = e.target.closest('[data-rm]')?.dataset.rm;
    if (i === undefined || !DIRS) return;
    const gone = DIRS.dirs[+i];
    saveDirs(DIRS.dirs.filter(d => d.removable && d !== gone).map(d => d.path));
  });
  $('#btnHelp').onclick = openHelp;
  document.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onVideoKey, true);
  window.addEventListener('keydown', onShift, true);
  window.addEventListener('keyup', onShift, true);
  window.addEventListener('blur', () => { if (shiftFast || zFast) { shiftFast = zFast = false; applyShiftSpeed(); } }); // nhả Shift lúc đang ở cửa sổ khác

  bindHistory();
  renderHistory();
  setTask('kis');
  renderCart();
  initTeam();
  refreshHealth();
  // Giống bản cũ: hỏi lại trước khi rời trang — chỉ khi danh sách nộp còn frame.
  window.addEventListener('beforeunload', e => { if (S.cart.length) { e.preventDefault(); e.returnValue = ''; } });
  $('#query').focus();
}
document.addEventListener('DOMContentLoaded', init);
