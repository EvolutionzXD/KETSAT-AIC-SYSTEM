// ---------------- Selected-video local refinement ----------------
// The old Filter button used to be an OCR/ASR placeholder.  It now performs
// a bounded second-stage search: the user selects one frame from each video,
// then the backend scores only those videos and returns a balanced pool of
// up to 100 locally best frames.

const selectedFilterVideos = window.selectedFilterVideos instanceof Map
  ? window.selectedFilterVideos
  : new Map();
window.selectedFilterVideos = selectedFilterVideos;
const SELECTED_VIDEO_FILTER_MAX = 20;

// Keep the last global KIS/QA result set outside the filtered rendering.  The
// user can return to it without issuing another expensive model search.
window.__selectedVideoFilterBaseResults = Array.isArray(
  window.__selectedVideoFilterBaseResults
) ? window.__selectedVideoFilterBaseResults : null;

function setRestoreSearchButtonVisible(visible) {
  const button = document.getElementById('restore-search-button');
  if (button) button.hidden = !visible;
}

function clearSelectedFilterHistory() {
  window.__selectedVideoFilterBaseResults = null;
  setRestoreSearchButtonVisible(false);
}

function restoreOriginalSearchResults(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const original = window.__selectedVideoFilterBaseResults;
  if (!Array.isArray(original) || !original.length) {
    showToast('Chưa có kết quả search gốc để khôi phục.', 'info');
    return;
  }
  clearSelectedFilterVideos();
  window.__renderingSelectedVideoFilter = false;
  if (typeof updateUIWithSearchResults === 'function') {
    updateUIWithSearchResults(original.slice(0, 100));
  }
  // updateUIWithSearchResults normally records a global search.  Keep the
  // captured set as the restore source after this explicit action as well.
  window.__lastGlobalSearchResults = original.slice(0, 100);
  setRestoreSearchButtonVisible(false);
  showToast('Đã quay lại kết quả search ban đầu.', 'info');
}

function selectedFilterLabel() {
  return document.getElementById('filter-button-label');
}

function updateFilterActionState() {
  const button = document.getElementById('filter-button');
  const label = selectedFilterLabel();
  const count = selectedFilterVideos.size;
  if (label) label.textContent = `Lọc frame tốt nhất${count ? ` (${count})` : ''}`;
  if (!button) return;
  button.setAttribute('aria-label', count
    ? `Lọc frame tốt nhất trong ${count} video đã chọn`
    : 'Chọn ít nhất một video để lọc frame tốt nhất');
  button.title = count
    ? `Tìm lại trong ${count} video đã chọn và lấy frame tốt nhất của từng video`
    : 'Chọn một hoặc nhiều video từ kết quả trước';
}

function refreshSelectedVideoButtons() {
  document.querySelectorAll('.video-filter-select-btn').forEach((button) => {
    const videoId = String(button.dataset.videoId || '');
    const selected = selectedFilterVideos.has(videoId);
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.textContent = selected ? 'Đã chọn' : 'Chọn video';
  });
}

function clearSelectedFilterVideos() {
  selectedFilterVideos.clear();
  refreshSelectedVideoButtons();
  updateFilterActionState();
}

// Called by update_result.js for every rendered result card.  The frame
// remains draggable/exportable; only the small button consumes its click.
function bindSelectedVideoPicker(div, result) {
  if (!div || !result || !result.video_id) return;
  let button = div.querySelector('.video-filter-select-btn');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'video-filter-select-btn';
    div.appendChild(button);
  }
  const videoId = String(result.video_id);
  button.dataset.videoId = videoId;
  button.title = `Chọn ${videoId} để lọc frame riêng`;
  button.setAttribute('aria-label', `Chọn video ${videoId}`);
  const selected = selectedFilterVideos.has(videoId);
  button.classList.toggle('is-selected', selected);
  button.setAttribute('aria-pressed', String(selected));
  button.textContent = selected ? 'Đã chọn' : 'Chọn video';
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (selectedFilterVideos.has(videoId)) {
      selectedFilterVideos.delete(videoId);
    } else {
      if (selectedFilterVideos.size >= SELECTED_VIDEO_FILTER_MAX) {
        showToast(`Chỉ có thể chọn tối đa ${SELECTED_VIDEO_FILTER_MAX} video mỗi lần.`, 'info');
        return;
      }
      selectedFilterVideos.set(videoId, {
        video_id: videoId,
        frame_id: Number(result.frame_id),
      });
    }
    refreshSelectedVideoButtons();
    updateFilterActionState();
  };
}

async function handleFilterAction(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (typeof activeTask !== 'undefined' && activeTask === 'trake') {
    showToast('TRAKE không dùng lọc video riêng; hãy chọn anchor/event.', 'info');
    return;
  }
  const selections = [...selectedFilterVideos.values()];
  if (!selections.length) {
    showToast('Hãy bấm “Chọn video” trên ít nhất một frame trước.', 'info');
    return;
  }
  const queries = typeof collectSearchQueries === 'function'
    ? collectSearchQueries()
    : [];
  const query = String(queries[0] || '').trim();
  if (!query) {
    showToast('Không tìm thấy query hiện tại để lọc.', 'error');
    return;
  }

  if (typeof toggleLoadingIndicator === 'function') toggleLoadingIndicator(true);
  if (typeof currentAbortController !== 'undefined' && currentAbortController) {
    currentAbortController.abort();
  }
  if (typeof currentAbortController !== 'undefined') {
    currentAbortController = new AbortController();
  }
  try {
    const response = await fetch(`${window.BACKEND_BASE}/api/search/selected-videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        selected_frames: selections,
        top_k_per_video: 100,
        output_limit: 100,
      }),
      signal: typeof currentAbortController !== 'undefined'
        ? currentAbortController.signal
        : undefined,
    });
    const envelope = await response.json();
    if (!response.ok || !envelope.success) {
      throw new Error(envelope.error || `HTTP ${response.status}`);
    }
    const results = Array.isArray(envelope.data) ? envelope.data.slice(0, 100) : [];
    const original = Array.isArray(window.__lastGlobalSearchResults)
      ? window.__lastGlobalSearchResults.slice(0, 100)
      : [];
    window.__selectedVideoFilterBaseResults = original;
    clearSelectedFilterVideos();
    window.__renderingSelectedVideoFilter = true;
    try {
      if (typeof updateUIWithSearchResults === 'function') {
        updateUIWithSearchResults(results);
      }
    } finally {
      window.__renderingSelectedVideoFilter = false;
    }
    window.__lastGlobalSearchResults = original.slice();
    setRestoreSearchButtonVisible(original.length > 0);
    showToast(
      results.length
        ? `Đã lọc ${results.length} frame tốt nhất trong ${selections.length} video.`
        : 'Không tìm thấy frame mới trong các video đã chọn.',
      results.length ? 'success' : 'info',
    );
  } catch (error) {
    if (error && error.name !== 'AbortError') {
      console.error('Selected-video filter error:', error);
      showToast(`Lỗi lọc video đã chọn: ${error.message}`, 'error');
    }
  } finally {
    if (typeof toggleLoadingIndicator === 'function') toggleLoadingIndicator(false);
  }
}

const selectedVideoFilterButton = document.getElementById('filter-button');
if (selectedVideoFilterButton) {
  selectedVideoFilterButton.addEventListener('click', handleFilterAction);
}
const restoreSearchButton = document.getElementById('restore-search-button');
if (restoreSearchButton) {
  restoreSearchButton.addEventListener('click', restoreOriginalSearchResults);
}
document.addEventListener('DOMContentLoaded', () => {
  updateFilterActionState();
  setRestoreSearchButtonVisible(
    Array.isArray(window.__selectedVideoFilterBaseResults) &&
    window.__selectedVideoFilterBaseResults.length > 0
  );
});
