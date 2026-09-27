//------------------------ API health/stats badge ------------------------//
// Polls GET /health and GET /api/stats on window.BACKEND_BASE so it's
// obvious in the UI whether the search API is actually reachable — the
// first query after a cold start can take minutes (FAISS/OCR/caption
// load), so "is it even up" is worth showing before someone types a query.

const HEALTH_POLL_INTERVAL_MS = 30000;

async function refreshHealthBadge() {
  const badge = document.getElementById('health-badge');
  if (!badge) return;

  try {
    const healthResponse = await fetch(`${window.BACKEND_BASE}/health`);
    if (!healthResponse.ok) throw new Error(`HTTP ${healthResponse.status}`);

    let statsText = '';
    try {
      const statsResponse = await fetch(`${window.BACKEND_BASE}/api/stats`);
      const statsEnvelope = await statsResponse.json();
      if (statsResponse.ok && statsEnvelope.success) {
        statsText = ` — ${statsEnvelope.data.query_count} queries`;
      }
    } catch (statsError) {
      // Stats are a nice-to-have; health alone is enough for the badge.
    }

    badge.className = 'health-badge ok';
    badge.title = `API OK${statsText}`;
  } catch (error) {
    badge.className = 'health-badge down';
    badge.title = `API không phản hồi: ${error.message}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  refreshHealthBadge();
  setInterval(refreshHealthBadge, HEALTH_POLL_INTERVAL_MS);
});
