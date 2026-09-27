//------------------------ Team real-time sync ------------------------//
// Talks to backend/team_sync.py. Wires 3 of its 6 channels into this UI:
//   /ws/team          — presence (who's online, badge in header)
//   /ws/dres/{id}      — shared DRES session (login once, whole team submits
//                        against the same evaluation)
//   /ws/queue/{id}      — shared submission queue (exportedImages, from
//                        export.js)
// /ws/trake, /ws/marking, /ws/history exist on the backend but have no UI
// here yet — this frontend's TRAKE flow (multi-scene textareas, see
// query_backend.js) doesn't have the PixelPals workspace's per-stage
// candidate/vote model to hang MAKE_KEY/PROPOSE_STAGE_FRAME off of.

function wsBase() {
  return window.BACKEND_BASE.replace(/^http/, 'ws');
}

function teamClientId() {
  let id = sessionStorage.getItem('teamClientId');
  if (!id) {
    id = 'c' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('teamClientId', id);
  }
  return id;
}

//------------------------------------------------------------------//
// Presence

let teamName = localStorage.getItem('teamMemberName') || '';
let teamSocket = null;
let heartbeatTimer = null;

function openTeamNamePrompt() {
  const name = window.prompt('Tên của bạn (hiện cho cả nhóm thấy):', teamName || '');
  if (name && name.trim()) {
    teamName = name.trim();
    localStorage.setItem('teamMemberName', teamName);
    sendHeartbeat();
    renderTeamBadge();
  }
}

function currentActivitySummary() {
  const queries = Array.from(document.querySelectorAll('.Search_Scene textarea[name="Text_Query"]'))
    .map(t => t.value.trim())
    .filter(Boolean);
  if (queries.length) return `Đang tìm: "${queries[0].slice(0, 28)}"`;
  return 'Đang rảnh';
}

function sendHeartbeat() {
  if (!teamName || !teamSocket || teamSocket.readyState !== WebSocket.OPEN) return;
  teamSocket.send(JSON.stringify({ type: 'heartbeat', name: teamName, status: currentActivitySummary() }));
}

function renderTeamBadge() {
  const badge = document.getElementById('team-badge');
  if (!badge) return;
  const online = (window.__teamRoster || []).filter(m => m.online);
  badge.textContent = teamName ? `👥 ${teamName} (${online.length} online)` : '👥 Chưa chọn tên';
  badge.title = online.map(m => `${m.name}: ${m.status || ''}`).join('\n') || 'Chưa có ai online';
}

function connectTeamSocket() {
  try {
    teamSocket = new WebSocket(`${wsBase()}/ws/team`);
  } catch (e) {
    return;
  }
  teamSocket.onopen = () => {
    if (teamName) sendHeartbeat();
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, 4000);
  };
  teamSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'roster') {
        window.__teamRoster = msg.members;
        renderTeamBadge();
      }
    } catch (e) {
      // ignore malformed frame
    }
  };
  teamSocket.onclose = () => {
    clearInterval(heartbeatTimer);
    setTimeout(connectTeamSocket, 3000);
  };
  teamSocket.onerror = () => {
    try { teamSocket.close(); } catch (e) { /* already closed */ }
  };
}

//------------------------------------------------------------------//
// Shared DRES session — mirrors dresSessionId/dresEvaluationId from
// submit_dres.js across every connected teammate.

let dresSocket = null;
let applyingRemoteDres = false; // guards against re-broadcasting what we just received

function connectDresSocket() {
  try {
    dresSocket = new WebSocket(`${wsBase()}/ws/dres/${teamClientId()}`);
  } catch (e) {
    return;
  }
  dresSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.action === 'SYNC_DRES' && msg.payload && msg.payload.sessionId) {
        applyingRemoteDres = true;
        dresSessionId = msg.payload.sessionId;
        dresEvaluationId = msg.payload.evaluationId;
        localStorage.setItem('dresSessionId', dresSessionId);
        localStorage.setItem('dresEvaluationId', dresEvaluationId);
        if (typeof updateDresLoginButton === 'function') updateDresLoginButton();
        applyingRemoteDres = false;
      }
    } catch (e) {
      // ignore malformed frame
    }
  };
  dresSocket.onclose = () => setTimeout(connectDresSocket, 3000);
}

// Called from submit_dres.js right after setActiveEvaluation() — broadcasts
// the now-current session/evaluation to every connected teammate.
function broadcastDresSession() {
  if (applyingRemoteDres) return;
  if (!dresSocket || dresSocket.readyState !== WebSocket.OPEN) return;
  dresSocket.send(JSON.stringify({
    action: 'UPDATE_DRES',
    payload: { sessionId: dresSessionId, evaluationId: dresEvaluationId },
  }));
}

//------------------------------------------------------------------//
// Shared submission queue — mirrors exportedImages from export.js.

let queueSocket = null;
let applyingRemoteQueue = false;

function connectQueueSocket() {
  try {
    queueSocket = new WebSocket(`${wsBase()}/ws/queue/${teamClientId()}`);
  } catch (e) {
    return;
  }
  queueSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      applyingRemoteQueue = true;
      if (msg.action === 'SYNC_QUEUE' && Array.isArray(msg.payload)) {
        exportedImages = msg.payload.map(queueItemToExportedImage);
        updateExportArea();
      } else if (msg.action === 'ADD_FRAME' && msg.payload) {
        const item = queueItemToExportedImage(msg.payload);
        if (!exportedImages.some(img => img.videoFramePart === item.videoFramePart)) {
          exportedImages.unshift(item);
          updateExportArea();
        }
      } else if (msg.action === 'REMOVE_FRAME' && msg.payload) {
        exportedImages = exportedImages.filter(img => img.videoFramePart !== msg.payload.id);
        updateExportArea();
      } else if (msg.action === 'CLEAR_QUEUE') {
        exportedImages = [];
        updateExportArea();
      }
      applyingRemoteQueue = false;
    } catch (e) {
      applyingRemoteQueue = false;
    }
  };
  queueSocket.onclose = () => setTimeout(connectQueueSocket, 3000);
}

function queueItemToExportedImage(item) {
  return { frameId: item.frameId, realFrameId: item.realFrameId, videoFramePart: item.id, src: item.src, frameInfo: item.frameInfo };
}

function exportedImageToQueueItem(item) {
  return { id: item.videoFramePart, frameId: item.frameId, realFrameId: item.realFrameId, src: item.src, frameInfo: item.frameInfo };
}

// Called from export.js right after a local exportedImages mutation.
function broadcastQueueAdd(item) {
  if (applyingRemoteQueue || !queueSocket || queueSocket.readyState !== WebSocket.OPEN) return;
  queueSocket.send(JSON.stringify({ action: 'ADD_FRAME', payload: exportedImageToQueueItem(item) }));
}

function broadcastQueueRemove(item) {
  if (applyingRemoteQueue || !queueSocket || queueSocket.readyState !== WebSocket.OPEN) return;
  queueSocket.send(JSON.stringify({ action: 'REMOVE_FRAME', payload: { id: item.videoFramePart } }));
}

function broadcastQueueClear() {
  if (applyingRemoteQueue || !queueSocket || queueSocket.readyState !== WebSocket.OPEN) return;
  queueSocket.send(JSON.stringify({ action: 'CLEAR_QUEUE' }));
}

//------------------------------------------------------------------//
// Shared marking state

let markingSocket = null;
window.marked_frames_state = { "incorrect": [], "caution": [] };

function connectMarkingSocket() {
  try {
    markingSocket = new WebSocket(`${wsBase()}/ws/marking/${teamClientId()}`);
  } catch (e) {
    return;
  }
  markingSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.action === 'SYNC_MARKING' && msg.payload) {
        window.marked_frames_state = msg.payload;
        // Dispatch event for show_video.js to listen to
        window.dispatchEvent(new Event('markersUpdated'));
      }
    } catch (e) {
      // ignore
    }
  };
  markingSocket.onclose = () => setTimeout(connectMarkingSocket, 3000);
}

//------------------------------------------------------------------//

document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('team-badge');
  if (badge) badge.addEventListener('click', openTeamNamePrompt);
  renderTeamBadge();
  connectTeamSocket();
  connectDresSocket();
  connectQueueSocket();
  connectMarkingSocket();
});
