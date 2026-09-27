//------------------------ Frontend runtime configuration ------------------------//
// Single place to point the UI at a different deployment. Every other file in
// src/scripts/ reads its backend URLs from here instead of hardcoding
// host/port/paths directly.
//
// The production UI must stay on its own origin: nginx owns the public
// endpoint and proxies /api and /ws to the private backend.  In particular,
// `?backend=http://localhost:8602` in a browser on another computer means
// that computer's localhost, not the UIT server.  Overrides are therefore
// available only while the UI itself is opened from localhost for development.
const _params = new URLSearchParams(window.location.search);
const _isLocalDevelopment = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
  .has(window.location.hostname);

function _configValue(paramName, storageKey, hardcodedDefault) {
  const fromQuery = _params.get(paramName);
  if (fromQuery) {
    localStorage.setItem(storageKey, fromQuery);
    return fromQuery;
  }
  return localStorage.getItem(storageKey) || hardcodedDefault;
}

function _sameOriginConfigValue(paramName, storageKey) {
  if (!_isLocalDevelopment) {
    // Remove an override saved by an older deployment so it cannot keep a
    // remote user's browser pointed at its own localhost after a refresh.
    localStorage.removeItem(storageKey);
    return window.location.origin;
  }
  return _configValue(paramName, storageKey, window.location.origin);
}

// Nginx is the single public origin and proxies /api and /ws to the internal
// Search API. A localhost development page can still use ?backend=.
window.BACKEND_BASE = window.BACKEND_BASE || _sameOriginConfigValue(
  'backend', 'backendBaseOverrideV2'
);

// The backend now exposes a constrained server-side SOLOAI writer.  Keeping
// this switch explicit allows an older/static deployment to fall back to the
// browser folder picker/download path without breaking export.
window.SOLOAI_SERVER_SAVE = true;

// Nginx serves immutable media directly. In production the frontend and
// /media tree share one origin, while a localhost development page can use
// ?media= without editing source files.
window.MEDIA_BASE = window.MEDIA_BASE || _sameOriginConfigValue(
  'media', 'mediaBaseOverride'
);

// DRES (Distributed Retrieval Evaluation Server) submission target. Default
// is the real local DRES instance in use (verified end-to-end 2026-08-12:
// login + evaluation list against http://192.168.28.151:5000 both work).
// Override via ?dres=<url> (same mechanism as ?backend= above), or edit the
// Server URL field directly in the DRES login modal (src/scripts/submit_dres.js)
// — that field also persists to localStorage independently.
window.DRES_BASE_URL = window.DRES_BASE_URL || _configValue('dres', 'dresBaseUrl', 'http://192.168.28.151:5000');
