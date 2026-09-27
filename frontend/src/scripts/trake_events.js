//------------------------ TRAKE event input ------------------------//
// TRAKE needs N ordered event descriptions, not the generic KIS "scene"
// UI (image tab / Temporal-Expansion toggle / OCR-ASR boxes — none of
// which search_trake() accepts). This renders N plain textareas under a
// single count control, shown only while activeTask === 'trake'
// (toggled from export.js::toggleTask). See query_backend.js for how
// getTrakeEventQueries() feeds into the actual API call.

const TRAKE_EVENT_COUNT_MIN = 1;
const TRAKE_EVENT_COUNT_MAX = 10;
const TRAKE_EVENT_COUNT_DEFAULT = 2;

function trakeManualInput(id) {
  return document.getElementById(id);
}

function updateTrakeManualSelectionHint() {
  const hint = trakeManualInput('trake-video-lock-hint');
  if (!hint) return;
  const videoInput = trakeManualInput('Trake-Video-Id');
  const frameInput = trakeManualInput('Trake-Anchor-Frame');
  const queryInput = trakeManualInput('Trake-Anchor-Query');
  const videoId = (videoInput?.value || '').trim();
  const frame = (frameInput?.value || '').trim();
  const query = (queryInput?.value || '').trim();
  const deepseekButton = document.getElementById('trake-deepseek-button');
  if (deepseekButton) deepseekButton.disabled = !(videoId || query);
  hint.classList.toggle('is-selected', Boolean(videoId || frame || query));
  if (videoId || frame || query) {
    const parts = [];
    if (videoId) parts.push(`video ${videoId}`);
    if (frame) parts.push(`frame ${frame}`);
    if (query) parts.push('query đã chọn');
    hint.textContent = `Anchor hiện tại: ${parts.join(' · ')}.`;
  } else {
    hint.textContent = 'Để trống các trường anchor để tìm TRAKE tự động.';
  }
}

// Read the optional manual anchor that is passed to POST /api/search/trake.
// These values are intentionally explicit so an operator can lock the search
// to a known video/frame or provide a short anchor description without adding
// OCR/ASR inputs back to the main search UI.
function getTrakeManualSearchParams() {
  const videoId = (trakeManualInput('Trake-Video-Id')?.value || '').trim();
  const frameText = (trakeManualInput('Trake-Anchor-Frame')?.value || '').trim();
  const anchorFrameId = frameText === '' ? null : Number(frameText);
  if (frameText !== '' && (!Number.isInteger(anchorFrameId) || anchorFrameId < 0)) {
    throw new Error('Anchor frame phải là số nguyên không âm.');
  }
  if (videoId && !/^[A-Za-z0-9_-]+$/.test(videoId)) {
    throw new Error('Anchor video chỉ được chứa chữ, số, dấu gạch dưới hoặc dấu gạch ngang.');
  }
  return {
    video_id: videoId || null,
    anchor_frame_id: anchorFrameId,
    anchor_query: (trakeManualInput('Trake-Anchor-Query')?.value || '').trim() || null,
  };
}

function setTrakeManualVideo(videoId, anchorFrameId = null, switchToTrake = false) {
  const normalizedVideoId = String(videoId || '').trim();
  if (!normalizedVideoId) return false;
  const videoInput = trakeManualInput('Trake-Video-Id');
  const frameInput = trakeManualInput('Trake-Anchor-Frame');
  if (videoInput) videoInput.value = normalizedVideoId;
  if (frameInput && anchorFrameId !== null && anchorFrameId !== undefined) {
    frameInput.value = String(anchorFrameId);
  }
  updateTrakeManualSelectionHint();
  if (switchToTrake && typeof toggleTask === 'function' && activeTask !== 'trake') {
    toggleTask('trake');
  }
  if (typeof showTemporaryAlert === 'function') {
    showTemporaryAlert(
      `Đã chọn anchor TRAKE ${normalizedVideoId}${anchorFrameId !== null && anchorFrameId !== undefined ? ` tại frame ${anchorFrameId}` : ''}.`
    );
  }
  return true;
}

function clearTrakeManualVideo() {
  ['Trake-Video-Id', 'Trake-Anchor-Frame', 'Trake-Anchor-Query'].forEach((id) => {
    const input = trakeManualInput(id);
    if (input) input.value = '';
  });
  updateTrakeManualSelectionHint();
}

// Preserves already-typed text when the count changes, so bumping N from
// 2 to 3 doesn't wipe events 1-2.
function renderTrakeEventBoxes(count) {
  const list = document.getElementById('trake-events-list');
  if (!list) return;

  const clamped = Math.min(TRAKE_EVENT_COUNT_MAX, Math.max(TRAKE_EVENT_COUNT_MIN, count));
  const existingValues = Array.from(list.querySelectorAll('.trake-event-query')).map(t => t.value);

  list.innerHTML = '';
  for (let i = 0; i < clamped; i++) {
    const row = document.createElement('div');
    row.className = 'trake-event-row';

    const label = document.createElement('span');
    label.className = 'trake-event-label';
    label.textContent = `E${i + 1}`;

    const textarea = document.createElement('textarea');
    textarea.className = 'trake-event-query';
    textarea.rows = 2;
    textarea.placeholder = `Mô tả sự kiện ${i + 1}...`;
    textarea.value = existingValues[i] || '';

    row.appendChild(label);
    row.appendChild(textarea);
    list.appendChild(row);
  }

  const countInput = document.getElementById('Trake-Event-Count');
  if (countInput) countInput.value = String(clamped);
}

// Ordered, non-empty event descriptions — the exact array search_trake()
// needs as `events`.
function getTrakeEventQueries() {
  return Array.from(document.querySelectorAll('.trake-event-query'))
    .map(t => t.value.trim())
    .filter(q => q.length > 0);
}

// Shows the TRAKE event block and hides the KIS/QA scene UI, or vice
// versa. Called from export.js::toggleTask on every task switch.
function setTrakeEventsVisible(isTrake) {
  const trakeBlock = document.getElementById('trake-events-block');
  if (trakeBlock) trakeBlock.style.display = isTrake ? 'block' : 'none';
  const deepseekButton = document.getElementById('trake-deepseek-button');
  if (deepseekButton) deepseekButton.hidden = !isTrake;
  // TRAKE has its own ordered-event and optional DeepSeek actions. Keep the
  // generic OCR/ASR filter available for KIS/QA, but hide it while TRAKE is
  // active instead of removing the node (filter_get_infor.js still binds it).
  const filterButton = document.getElementById('filter-button');
  if (filterButton) {
    filterButton.hidden = isTrake;
    filterButton.setAttribute('aria-hidden', String(isTrake));
  }

  document.querySelectorAll('.Search_Scene').forEach(scene => {
    scene.style.display = isTrake ? 'none' : '';
  });
}

document.addEventListener('DOMContentLoaded', function () {
  renderTrakeEventBoxes(TRAKE_EVENT_COUNT_DEFAULT);

  const countInput = document.getElementById('Trake-Event-Count');
  const decreaseButton = document.getElementById('trake-count-decrease');
  const increaseButton = document.getElementById('trake-count-increase');

  countInput?.addEventListener('change', () => {
    renderTrakeEventBoxes(parseInt(countInput.value, 10) || TRAKE_EVENT_COUNT_DEFAULT);
  });

  decreaseButton?.addEventListener('click', () => {
    renderTrakeEventBoxes((parseInt(countInput.value, 10) || TRAKE_EVENT_COUNT_DEFAULT) - 1);
  });

  increaseButton?.addEventListener('click', () => {
    renderTrakeEventBoxes((parseInt(countInput.value, 10) || TRAKE_EVENT_COUNT_DEFAULT) + 1);
  });

  ['Trake-Video-Id', 'Trake-Anchor-Frame', 'Trake-Anchor-Query']
    .forEach((id) => trakeManualInput(id)?.addEventListener('input', updateTrakeManualSelectionHint));

  document.getElementById('trake-clear-video')?.addEventListener('click', clearTrakeManualVideo);
  document.getElementById('trake-use-open-video')?.addEventListener('click', async () => {
    const videoInput = trakeManualInput('Trake-Video-Id');
    const typedVideoId = String(videoInput?.value || '')
      .trim()
      .replace(/\.mp4$/i, '')
      .toUpperCase();
    const frameText = document.getElementById('vcalc-frame-index')?.textContent?.trim();
    const currentFrameId = frameText !== '' && /^\d+$/.test(frameText || '')
      ? Number(frameText)
      : null;

    // If an ID is typed, open that video. The old handler only read
    // current_active_video_id, so a manually entered ID was ignored.
    if (typedVideoId) {
      if (!/^L\d+_V\d+$/.test(typedVideoId)) {
        if (typeof showTemporaryAlert === 'function') {
          showTemporaryAlert('Video ID không hợp lệ. Ví dụ đúng: L21_V001.');
        }
        videoInput?.focus();
        return;
      }
      if (typeof window.openVideoById !== 'function') {
        if (typeof showTemporaryAlert === 'function') {
          showTemporaryAlert('Trình xem video chưa sẵn sàng.');
        }
        return;
      }

      // Keep a manually entered anchor frame intact. Opening at 0 avoids
      // guessing seconds from a frame without FPS metadata.
      setTrakeManualVideo(typedVideoId, null, false);
      try {
        await window.openVideoById(typedVideoId, 0);
        if (typeof showTemporaryAlert === 'function') {
          showTemporaryAlert(`Đã mở video ${typedVideoId}.`);
        }
      } catch (error) {
        console.error('Open TRAKE anchor video failed:', error);
        if (typeof showTemporaryAlert === 'function') {
          showTemporaryAlert(`Không mở được video ${typedVideoId}.`);
        }
      }
      return;
    }

    // With no manual ID, keep the original convenience action: copy the
    // video/frame currently shown in the shared viewer.
    const activeVideoId = String(window.current_active_video_id || '').trim();
    if (!activeVideoId) {
      if (typeof showTemporaryAlert === 'function') {
        showTemporaryAlert('Hãy nhập Video ID hoặc mở một video trước.');
      }
      return;
    }
    setTrakeManualVideo(activeVideoId, currentFrameId, false);
  });
  document.getElementById('trake-deepseek-button')?.addEventListener('click', async () => {
    const manual = getTrakeManualSearchParams();
    if (!manual.video_id && !manual.anchor_query) {
      if (typeof showTemporaryAlert === 'function') {
        showTemporaryAlert('Chọn Anchor video hoặc nhập Anchor query trước.');
      }
      return;
    }
    if (typeof performSearchFromTextareas === 'function') {
      await performSearchFromTextareas({ trakeDeepSeek: true });
    }
  });
  updateTrakeManualSelectionHint();
});
