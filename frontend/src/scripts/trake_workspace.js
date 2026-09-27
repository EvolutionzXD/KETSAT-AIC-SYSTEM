//------------------------ TRAKE team workspace ------------------------//
// Ported from PixelPals' renderTrakeWorkspace, adapted to this project's
// real backend instead of theirs:
//  "Auto" (auto-align) IS our existing POST /api/search/trake (DP
//     longest-increasing-chain over RRF hits, see search_trake in
//     src/search/trake_search.py)  already real, already tested. Clicking
//     "🔑 Make Key" on a TRAKE result (see update_result.js) locks that
//     video for the team AND seeds one pre-locked stage per event straight
//     from the DP chain, so there's no separate DTW re-implementation here
//     the way PixelPals' /api/trake_search has.
//  Team coordination rides /ws/trake/{clientId}, wired 1:1 against
//     backend/team_sync.py's trake_session_state (ported from PixelPals'
//     app/ws_sync.py  same action names: MAKE_KEY, ADD_STAGE,
//     PROPOSE_STAGE_FRAME, VOTE_STAGE_FRAME, LOCK_STAGE_FRAME, etc).
//  Frame proposals are time-based only (mm:ss or "use current player
//     time")  PixelPals also supports pasting/dropping a screenshot as a
//     candidate; that's dropped here as out of scope for this port.
//  Video playback uses this project's real GET /api/videos/{video_id}
//     (Range-request mp4) instead of PixelPals' /api/media/{video_id}.
//  Submits via backend/dres_proxy.py (POST /api/dres/submit, task=TRAKE)
//     once every stage has a locked candidate.

let trakeState = {
  lockedVideoId: null,
  lockedBy: null,
  votes: [],
  stages: [],
};
let trakeWsSocket = null;
let trakeActiveStageId = null;

function trakeWs() {
  if (!trakeWsSocket || trakeWsSocket.readyState > WebSocket.OPEN) {
    trakeWsSocket = new WebSocket(`${wsBase()}/ws/trake/${teamClientId()}`);
    trakeWsSocket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.action === 'SYNC_TRAKE') {
          trakeState = msg.payload;
          if (!trakeState.stages.some(s => s.id === trakeActiveStageId)) {
            trakeActiveStageId = trakeState.stages[0] ? trakeState.stages[0].id : null;
          }
          renderTrakeWorkspace();
        }
      } catch (e) {
        // ignore malformed frame
      }
    };
    trakeWsSocket.onclose = () => { trakeWsSocket = null; setTimeout(trakeWs, 3000); };
  }
  return trakeWsSocket;
}

function trakeSend(action, payload) {
  const ws = trakeWs();
  const body = JSON.stringify({ action, payload: payload || {} });
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(body);
  } else {
    ws.addEventListener('open', () => ws.send(body), { once: true });
  }
}

function requireTeamName() {
  if (!teamName) {
    showTemporaryAlert('Select your name first (press badge "👥" at top corner).');
    openTeamNamePrompt();
    return false;
  }
  return true;
}

//------------------------------------------------------------------//
// Entry point  called from the "🔑 Make Key" button on a TRAKE result
// (see update_result.js::updateRightPanel_trake). Locks the video AND
// seeds one pre-locked stage per event straight from the DP chain that
// already found it  this IS the auto-align.

function makeTrakeKeyFromResult(video) {
  if (!requireTeamName()) return;

  trakeSend('MAKE_KEY', { sourceFrame: { video: video.video_id }, madeBy: teamName });

  const frameIds = video.frame_ids.filter(f => f !== null);
  const timestamps = video.timestamps_seconds.filter(t => t !== null);

  // Fire-and-forget sequence: ADD_STAGE then PROPOSE+LOCK for each event.
  // The backend processes each WS message in order on this connection, so
  // this reliably builds N stages with N locked candidates even though
  // trake_session_state is only known to the client after each broadcast
  // comes back  we don't need the stage id back client-side because
  // PROPOSE/LOCK target "whichever stage was just added" by re-deriving it
  // from the synced state right before sending, one event at a time.
  let i = 0;
  const seedNext = () => {
    if (i >= frameIds.length) return;
    trakeSend('ADD_STAGE', { label: `S${i + 1}` });
    setTimeout(() => {
      const stage = trakeState.stages[trakeState.stages.length - 1];
      if (!stage) { i += 1; seedNext(); return; }
      const timeMs = Math.round(timestamps[i] * 1000);
      trakeSend('PROPOSE_STAGE_FRAME', {
        stageId: stage.id, proposedBy: teamName, kind: 'time',
        timeMs, videoId: video.video_id,
      });
      setTimeout(() => {
        const freshStage = trakeState.stages.find(s => s.id === stage.id);
        const cand = freshStage && freshStage.candidates[freshStage.candidates.length - 1];
        if (cand) trakeSend('LOCK_STAGE_FRAME', { stageId: stage.id, candidateId: cand.id });
        i += 1;
        setTimeout(seedNext, 150);
      }, 150);
    }, 150);
  };
  seedNext();

  showTemporaryAlert(`🔑 Locked ${video.video_id} auto aligning ${frameIds.length} stage from search results...`);
}

//------------------------------------------------------------------//
// Rendering

function ensureTrakeWorkspaceEl() {
  let el = document.getElementById('trake-workspace');
  if (!el) {
    el = document.createElement('div');
    el.id = 'trake-workspace';
    el.className = 'trake-workspace';
    document.body.appendChild(el);
  }
  return el;
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function parseTimeInput(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const [m, s] = trimmed.split(':').map(Number);
    if (Number.isNaN(m) || Number.isNaN(s)) return null;
    return Math.round((m * 60 + s) * 1000);
  }
  const seconds = parseFloat(trimmed);
  return Number.isNaN(seconds) ? null : Math.round(seconds * 1000);
}

function renderTrakeWorkspace() {
  const el = ensureTrakeWorkspaceEl();

  if (!trakeState.lockedVideoId) {
    el.classList.remove('open');
    el.innerHTML = '';
    return;
  }
  el.classList.add('open');

  const stages = trakeState.stages;
  const allLocked = stages.length > 0 && stages.every(s => s.lockedCandidateId);

  el.innerHTML = `
    <div class="trake-ws-header">
      <div class="trake-ws-title">🔒 ${trakeState.lockedVideoId}${trakeState.lockedBy ? ` - locked by ${trakeState.lockedBy}` : ''}</div>
      <div>
        <button id="trake-ws-unlock" class="trake-ws-btn">Unlock video</button>
        <button id="trake-ws-close" class="trake-ws-btn">✕ Collapse</button>
      </div>
    </div>
    <div class="trake-ws-player-wrap">
      <video id="trake-ws-video" class="trake-ws-video" controls preload="metadata"
             src="${window.BACKEND_BASE}/api/videos/${encodeURIComponent(trakeState.lockedVideoId)}"></video>
    </div>
    <div class="trake-ws-stages-rail" id="trake-ws-stages-rail"></div>
    <div class="trake-ws-footer">
      <button id="trake-ws-add-stage" class="trake-ws-btn">＋ Add stage</button>
      <button id="trake-ws-submit" class="trake-ws-btn trake-ws-btn-primary" ${allLocked ? '' : 'disabled'}
              title="${allLocked ? 'Submit TRAKE chain to DRES' : 'Each stage needs 1 frame locked before submitting'}">
        📨 Submit DRES (${stages.filter(s => s.lockedCandidateId).length}/${stages.length} stage)
      </button>
    </div>
  `;

  const rail = document.getElementById('trake-ws-stages-rail');
  stages.forEach((stage) => {
    rail.appendChild(renderTrakeStageCard(stage));
  });

  document.getElementById('trake-ws-unlock').addEventListener('click', () => trakeSend('UNLOCK_VIDEO'));
  document.getElementById('trake-ws-close').addEventListener('click', () => el.classList.remove('open'));
  document.getElementById('trake-ws-add-stage').addEventListener('click', () => {
    if (!requireTeamName()) return;
    trakeSend('ADD_STAGE', {});
  });
  document.getElementById('trake-ws-submit').addEventListener('click', submitTrakeChainToDres);
}

function renderTrakeStageCard(stage) {
  const card = document.createElement('div');
  card.className = `trake-ws-stage ${trakeActiveStageId === stage.id ? 'active' : ''}`;
  card.dataset.stageId = stage.id;

  const locked = stage.candidates.find(c => c.id === stage.lockedCandidateId);
  const others = stage.candidates.filter(c => c.id !== stage.lockedCandidateId);

  card.innerHTML = `
    <div class="trake-stage-head">
      <span class="trake-stage-label">${stage.label}</span>
      <button class="trake-stage-del" title="Delete stage">×</button>
    </div>
    ${locked ? `
      <div class="trake-stage-locked">
        <div class="trake-stage-locked-time">${fmtMs(locked.timeMs)}</div>
        <div class="trake-stage-locked-by">🔒 ${locked.proposedBy} - ${locked.votes.length} vote</div>
      </div>
    ` : '<div class="empty-mini">No frames locked.</div>'}
    ${others.length ? others.map(c => `
      <div class="trake-stage-cand" data-cand-id="${c.id}">
        <span>${fmtMs(c.timeMs)} - ${c.proposedBy} - ${c.votes.length} vote</span>
        <button class="trake-stage-cand-vote" data-cand-id="${c.id}">Vote</button>
        <button class="trake-stage-cand-lock" data-cand-id="${c.id}">Lock</button>
        <button class="trake-stage-cand-del" data-cand-id="${c.id}">×</button>
      </div>
    `).join('') : ''}
    <div class="trake-stage-add">
      <input class="trake-stage-time-input" placeholder="mm:ss or seconds" />
      <button class="trake-stage-time-btn">⏱ Propose</button>
      <button class="trake-stage-use-current-btn" title="Use current video time">▶ Current</button>
    </div>
  `;

  card.addEventListener('click', () => { trakeActiveStageId = stage.id; });

  card.querySelector('.trake-stage-del').addEventListener('click', () => trakeSend('REMOVE_STAGE', { stageId: stage.id }));

  const timeInput = card.querySelector('.trake-stage-time-input');
  const proposeAt = (timeMs) => {
    if (!requireTeamName() || timeMs === null) return;
    trakeSend('PROPOSE_STAGE_FRAME', { stageId: stage.id, proposedBy: teamName, kind: 'time', timeMs, videoId: trakeState.lockedVideoId });
  };
  card.querySelector('.trake-stage-time-btn').addEventListener('click', () => proposeAt(parseTimeInput(timeInput.value)));
  card.querySelector('.trake-stage-use-current-btn').addEventListener('click', () => {
    const video = document.getElementById('trake-ws-video');
    proposeAt(video ? Math.round(video.currentTime * 1000) : null);
  });

  card.querySelectorAll('.trake-stage-cand-vote').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!requireTeamName()) return;
      trakeSend('VOTE_STAGE_FRAME', { stageId: stage.id, candidateId: btn.dataset.candId, voter: teamName });
    });
  });
  card.querySelectorAll('.trake-stage-cand-lock').forEach(btn => {
    btn.addEventListener('click', () => trakeSend('LOCK_STAGE_FRAME', { stageId: stage.id, candidateId: btn.dataset.candId }));
  });
  card.querySelectorAll('.trake-stage-cand-del').forEach(btn => {
    btn.addEventListener('click', () => trakeSend('REMOVE_STAGE_FRAME', { stageId: stage.id, candidateId: btn.dataset.candId }));
  });

  return card;
}

async function submitTrakeChainToDres() {
  if (!dresSessionId || !dresEvaluationId) {
    showTemporaryAlert('Not logged in to DRES  please login and try again.');
    openDresLoginModal();
    return;
  }
  const stages = trakeState.stages;
  if (!stages.length || !stages.every(s => s.lockedCandidateId)) {
    showTemporaryAlert('Each stage needs 1 frame locked before submitting.');
    return;
  }
  // DRES TRAKE text requires original frame IDs, not milliseconds.  The
  // workspace stores stage positions as timeMs, so convert with the video's
  // metadata FPS before building the answer string.
  await ensureFpsCache();
  const fps = fpsFor(trakeState.lockedVideoId);
  if (!Number.isFinite(fps) || fps <= 0) {
    showTemporaryAlert('Chưa tải được FPS metadata của video TRAKE.');
    return;
  }
  const frameIds = stages.map((s) => {
    const cand = s.candidates.find(c => c.id === s.lockedCandidateId);
    return Math.round((Number(cand.timeMs) * fps) / 1000);
  });
  const formattedAnswer = typeof formatDresTrakeFrameAnswer === 'function'
    ? formatDresTrakeFrameAnswer(trakeState.lockedVideoId, frameIds)
    : `TR-${trakeState.lockedVideoId}-${frameIds.join(',')}`;
  if (!formattedAnswer) return;
  await submitFrameInfo({
    baseUrl: dresBase(),
    session: dresSessionId,
    evaluationId: dresEvaluationId,
    task: 'Q&A',
    answer: formattedAnswer,
  });
}

document.addEventListener('DOMContentLoaded', () => {
  trakeWs();
});
