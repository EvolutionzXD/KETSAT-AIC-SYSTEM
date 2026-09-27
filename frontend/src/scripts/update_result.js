//------------------------ Update result ------------------------//
// Result shape comes straight from backend/app.py's real envelope (see
// src/pipeline/search_engine.py::_format_results): video_id, frame_id,
// timestamp_seconds, score, ocr_snippet, caption_snippet, audio_segment_text,
// frame_exists. No more Milvus-era `result.entity.*` wrapper.

// Cache for storing search results
const searchCache = new Map();

// AbortController for cancelling ongoing requests
let currentAbortController = null;

// Tải B2 mapping metadata tĩnh 1 lần khi load trang
window.B2_MAPPING = null;
fetch(`./b2_mapping.json`)
  .then(r => r.json())
  .then(data => { 
    window.B2_MAPPING = data; 
    console.debug(`[B2-MAPPING] Successfully loaded mapping for ${Object.keys(data).length} videos.`);
  })
  .catch(e => console.error("[B2-MAPPING-ERROR] Could not load B2 mapping", e));

// Tải thêm Video Metadata tĩnh để xác định Batch của Video (đỡ phải parse thủ công)
window.VIDEO_METADATA = null;
fetch(`./video_metadata.json`)
  .then(r => r.json())
  .then(data => { 
    window.VIDEO_METADATA = data; 
    console.debug(`[VIDEO-METADATA] Successfully loaded metadata for ${Object.keys(data).length} videos.`);
  })
  .catch(e => console.error("[VIDEO-METADATA-ERROR] Could not load video metadata", e));


// Create a single IntersectionObserver instance
const imageObserver = new IntersectionObserver((entries, observer) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const img = entry.target;
      img.src = img.dataset.src;
      img.dataset.fetchStartedAt = String(performance.now());
      observer.unobserve(img);
    }
  });
}, {
  rootMargin: '100px'
});


// Inline placeholder shown when a keyframe image fails to load
const BROKEN_IMAGE_PLACEHOLDER =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNkMWQ1ZGIiIHN0cm9rZS13aWR0aD0iMS41Ij48cmVjdCB4PSIzIiB5PSIzIiB3aWR0aD0iMTgiIGhlaWdodD0iMTgiIHJ4PSIyIi8+PGNpcmNsZSBjeD0iOC41IiBjeT0iOC41IiByPSIxLjUiLz48cGF0aCBkPSJtMjEgMTUtNS01LTExIDExIi8+PC9zdmc+';

// KIS/QA always render the first 100 results returned by the backend.  There
// is deliberately no client-side count slider: changing the visible count
// made it look like a new search and confused the selected-video workflow.
const RESULT_FRAME_LIMIT_MAX = 100;
let latestSearchResults = [];

function frameImageUrl(videoId, frameId) {
  if (window.B2_MAPPING && window.B2_MAPPING[videoId]) {
    // window.B2_MAPPING[videoId] is e.g. "frames/087e4a491184f8a95a30bde7/27b3fa95552cce43"
    const hashFolder = window.B2_MAPPING[videoId];
    const fileName = `${String(frameId).padStart(8, '0')}.jpg`;
    
    // Instead of hardcoding a 7-day token in the frontend, we ask our FastAPI backend
    // to dynamically sign this URL and redirect us. This makes it 100% secure and permanent.
    const b2Path = `frames/batch1_candidates/${hashFolder}/${fileName}`;
    const proxyUrl = `${window.BACKEND_BASE || ''}/api/b2_media/${b2Path}`;
    
    // console.debug(`[B2-PROXY-PRESIGNED] Loading videoId=${videoId} frame=${frameId} -> ${proxyUrl}`);
    return proxyUrl;
  }
  
  // Use the API directly if mapping is missing
  const fallbackUrl = legacyFrameImageUrl(videoId, frameId);
  console.debug(`[B2-PROXY] Missing mapping for videoId=${videoId}, fallback to -> ${fallbackUrl}`);
  return fallbackUrl;
}

function legacyFrameImageUrl(videoId, frameId) {
  // Gọi API backend (cũ). Dùng làm fallback khi B2 báo 404 (do frame lân cận không tồn tại trên B2)
  return `${window.BACKEND_BASE}/api/frames/${videoId}/${frameId}`;
}

// Shows video_id + real frame index (not seconds) â€” the label under every
// result thumbnail. Timestamp seconds are still tracked separately, via
// img.dataset.timestampSeconds, for DRES ms-conversion; never parsed back
// out of this display string (see export.js's drag/middleClick handlers).
function frameInfoText(result) {
  return `${result.video_id}-${result.frame_id}`;
}

// A result frame can seed the optional TRAKE anchor.  This keeps the
// video/frame relationship explicit and avoids retyping IDs in the TRAKE
// panel.  The button is deliberately unobtrusive and only appears on hover.
function bindTrakeVideoPicker(div, result) {
  if (!div || !result?.video_id) return;
  let button = div.querySelector('.trake-pick-video-btn');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'trake-pick-video-btn';
    div.appendChild(button);
  }
  button.textContent = 'TRAKE';
  button.title = `Chọn ${result.video_id} và frame này làm anchor TRAKE`;
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof setTrakeManualVideo === 'function') {
      setTrakeManualVideo(result.video_id, result.frame_id, true);
    }
  };
}

function createImageDiv(result, index) {
  const frameInfo = frameInfoText(result);

  const matchedText = result.audio_segment_text || result.ocr_snippet || result.caption_snippet || '';

  const div = document.createElement('div');
  div.className = `img-dis`;
  if (matchedText) {
    div.dataset.matchedText = matchedText;
  }
  div.title = 'Chuột phải: mở cửa sổ xem video và trích frame. Không dùng để lọc hoặc xếp hạng.';
  div.innerHTML = `
    <img alt="" class="result" loading="eager" height="100px" id="${index}" src="${frameImageUrl(result.video_id, result.frame_id)}">
    <div class="play-overlay"></div>
    <div class="infor">${frameInfo}</div>
    <div class="export_icon"></div>
  `;
  if (matchedText) {
    const tooltip = document.createElement('div');
    tooltip.className = 'text-match-tooltip';
    tooltip.textContent = matchedText;
    div.appendChild(tooltip);
  }
  bindTrakeVideoPicker(div, result);
  if (typeof bindSelectedVideoPicker === 'function') {
    bindSelectedVideoPicker(div, result);
  }

  const img = div.querySelector('img');
  img.dataset.realFrameId = result.frame_id;
  img.dataset.timestampSeconds = result.timestamp_seconds;
  img.dataset.fetchStartedAt = performance.now();
  img.setAttribute('draggable', 'true');
  img.addEventListener('dragstart', drag);
  img.addEventListener('error', function onImgError() {
    if (!img.dataset.legacyFallbackAttempted) {
      img.dataset.legacyFallbackAttempted = '1';
      img.src = legacyFrameImageUrl(result.video_id, result.frame_id);
      return;
    }
    img.removeEventListener('error', onImgError);
    img.src = BROKEN_IMAGE_PLACEHOLDER;
  });
  img.addEventListener("load", () => {
    const started = Number(img.dataset.fetchStartedAt || 0);
    if (started) console.debug(`[frame-timing] ${result.video_id}:${result.frame_id} ${(performance.now() - started).toFixed(1)}ms`);
  });

  // Attach hover events for video preview (single shared video element)
  div.addEventListener('mouseenter', () => handleHoverEnter(div, img, result));
  div.addEventListener('mouseleave', () => handleHoverLeave(div));

  const exportIcon = div.querySelector('.export_icon');
  exportIcon.addEventListener('click', () => {
    addImageToExportArea(
      result.timestamp_seconds,
      frameImageUrl(result.video_id, result.frame_id),
      frameInfo,
      true,
      result.frame_id
    );
  });

  return div;
}


// Update UI with search results using IntersectionObserver for lazy loading
// Update the new right panel
function updateRightPanel_list(results) {
  const listPhoto = document.getElementById("list-photo");
  const fragment = document.createDocumentFragment();
  const existingDivs = Array.from(listPhoto.children);

  const updatedDivs = results.map((result, index) => {
    let div;
    if (index < existingDivs.length) {
      div = existingDivs[index];
      div.style.display = 'block';
    } else {
      div = createImageDiv(result, index + 1);
      fragment.appendChild(div);
    }

    const img = div.querySelector('img');
    const infor = div.querySelector('.infor');
    img.id = index + 1;
    img.dataset.realFrameId = result.frame_id;
    img.dataset.timestampSeconds = result.timestamp_seconds;
    delete img.dataset.legacyFallbackAttempted;

    img.dataset.src = frameImageUrl(result.video_id, result.frame_id);
    // Do not rely on the browser's lazy-image intervention here. It can
    // replace empty-src thumbnails with placeholders before the observer
    // fires. The result set is small, so load the real frame immediately.
    img.src = img.dataset.src;
    infor.textContent = frameInfoText(result);
    bindTrakeVideoPicker(div, result);
    if (typeof bindSelectedVideoPicker === 'function') {
      bindSelectedVideoPicker(div, result);
    }

    const matchedText = result.audio_segment_text || result.ocr_snippet || result.caption_snippet || '';
    if (matchedText) {
      div.dataset.matchedText = matchedText;
      let tooltip = div.querySelector('.text-match-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'text-match-tooltip';
        div.appendChild(tooltip);
      }
      tooltip.textContent = matchedText;
    } else {
      delete div.dataset.matchedText;
      const tooltip = div.querySelector('.text-match-tooltip');
      if (tooltip) tooltip.remove();
    }

    // Re-apply local highlight filter if active
    const highlightInput = document.getElementById('local-highlight-input');
    if (highlightInput && highlightInput.value.trim().length > 0) {
      const keyword = highlightInput.value.trim().toLowerCase();
      if (matchedText && matchedText.toLowerCase().includes(keyword)) {
        div.classList.add('has-text-match');
      } else {
        div.classList.remove('has-text-match');
      }
    } else {
      div.classList.remove('has-text-match');
    }

    imageObserver.observe(img);
    return div;
  });

  // Remove excess divs
  existingDivs.slice(results.length).forEach(div => div.remove());

  // Append new divs if any
  if (fragment.children.length > 0) {
    listPhoto.appendChild(fragment);
  }

  listPhoto.scrollTop = 0;

  return updatedDivs;
}



//-----------------------------------------------------------------------------------------------------//

// Get current results from the right panel
function getCurrentResults() {
  return Array.from(document.querySelectorAll('.img-dis')).map(div => {
    const [videoId, timestampSeconds] = div.querySelector('.infor').textContent.split('-');
    return {
      video_id: videoId,
      timestamp_seconds: parseFloat(timestampSeconds),
      id: div.querySelector('img').id,
    };
  });
}


// Group the results by video
function groupResultsByVideo(results) {
  return results.reduce((groups, result) => {
    const videoName = result.video_id;
    (groups[videoName] = groups[videoName] || []).push(result);
    return groups;
  }, {});
}

// Update the new right panel
function updateRightPanel_rows(results) {
  const imagesRows = document.getElementById('images-rows');
  imagesRows.innerHTML = ''; // Clear existing content

  const videoGroups = groupResultsByVideo(results);

  const fragment = document.createDocumentFragment();

  Object.entries(videoGroups).forEach(([videoName, videoResults], index) => {
    const videoSection = document.createElement('div');
    videoSection.className = 'group-frame';

    if (index > 0) {
      videoSection.appendChild(document.createElement('hr'));
    }

    const videoTitle = document.createElement('h3');
    videoTitle.textContent = videoName;
    videoSection.appendChild(videoTitle);

    const resultFragment = document.createDocumentFragment();
    videoResults.forEach((result) => {
      const originalIndex = results.indexOf(result);
      const imgDiv = createImageDiv(result, originalIndex + 1);
      resultFragment.appendChild(imgDiv);
    });

    videoSection.appendChild(resultFragment);
    fragment.appendChild(videoSection);
  });

  imagesRows.appendChild(fragment);

  imagesRows.scrollTop = 0;
}


//------------------------ TRAKE rendering ------------------------//
// search_trake results are per-video ordered event chains, not flat frame
// hits: [{video_id, frame_ids: [f1, f2, ...], timestamps_seconds: [...],
// moment_scores, total_score, missing_events, rank}]. Flatten into the same
// indexable `data` array showVideo()/exportedImages already expect, tagging
// each frame with its event ordinal for the "E1/E2/..." badge.

function flattenTrakeResults(trakeResults) {
  const flat = [];
  trakeResults.forEach((video) => {
    video.frame_ids.forEach((frameId, eventIndex) => {
      if (frameId === null) return; // missing_events slot â€” nothing to show
      flat.push({
        video_id: video.video_id,
        frame_id: frameId,
        timestamp_seconds: video.timestamps_seconds[eventIndex],
        event_index: eventIndex,
        rank: video.rank,
      });
    });
  });
  return flat;
}

function createTrakeFrameDiv(result, index) {
  const div = createImageDiv(result, index);
  const badge = document.createElement('div');
  badge.className = 'event-badge';
  badge.textContent = `E${result.event_index + 1}`;
  div.appendChild(badge);
  return div;
}

function updateRightPanel_trake(trakeResults, flatResults) {
  const imagesRows = document.getElementById('images-rows');
  imagesRows.innerHTML = '';

  const fragment = document.createDocumentFragment();
  let flatIndex = 0;

  trakeResults.forEach((video, videoIndex) => {
    const videoSection = document.createElement('div');
    videoSection.className = 'group-frame';
    if (videoIndex > 0) videoSection.appendChild(document.createElement('hr'));

    const videoTitle = document.createElement('h3');
    videoTitle.textContent = `${video.video_id} â€” total ${video.total_score}`;
    videoSection.appendChild(videoTitle);

    const keyButton = document.createElement('button');
    keyButton.className = 'trake-make-key-btn';
    keyButton.textContent = 'ðŸ”‘ LÃ m Key';
    keyButton.title = 'Chá»‘t video nÃ y cho cáº£ nhÃ³m vÃ  má»Ÿ workspace TRAKE vá»›i chuá»—i khung hÃ¬nh Ä‘Ã£ tÃ¬m Ä‘Æ°á»£c (tá»± Ä‘á»™ng align)';
    keyButton.addEventListener('click', () => {
      if (typeof makeTrakeKeyFromResult === 'function') makeTrakeKeyFromResult(video);
    });
    videoSection.appendChild(keyButton);

    const chainFragment = document.createDocumentFragment();
    video.frame_ids.forEach((frameId) => {
      if (frameId === null) return;
      flatIndex += 1;
      chainFragment.appendChild(createTrakeFrameDiv(flatResults[flatIndex - 1], flatIndex));
    });
    videoSection.appendChild(chainFragment);
    fragment.appendChild(videoSection);
  });

  imagesRows.appendChild(fragment);
  imagesRows.scrollTop = 0;
}


// Update both panels
function updateUIWithSearchResults(results) {
  // Hide empty state when results arrive
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.classList.add('hidden');

  if (typeof activeTask !== 'undefined' && activeTask === 'trake') {
    latestSearchResults = [];
    const flat = flattenTrakeResults(results);
    data = flat;
    cleanupSearchResults();
    updateRightPanel_trake(results, flat);
    document.getElementById('mode-toggle').checked = true;
    togglePanelLayout.call({ checked: true });
  } else {
    data = results;
    latestSearchResults = Array.isArray(results)
      ? results.slice(0, RESULT_FRAME_LIMIT_MAX)
      : [];
    // Keep a copy of the last global result set so selected-video refinement
    // can restore it after the local filter finishes.  The filter handler
    // replaces this with its captured copy while rendering filtered results.
    if (!window.__renderingSelectedVideoFilter) {
      window.__lastGlobalSearchResults = latestSearchResults.slice();
    }
    const visibleResults = latestSearchResults;
    // KIS/QA results belong to the thumbnail panel.  Restore its visible
    // state on every search so a previous layout toggle cannot leave loaded
    // frames behind a hidden panel.
    const gridPanel = document.querySelector('.show-image-1');
    const rowPanel = document.querySelector('.show-image-2');
    if (gridPanel) gridPanel.style.display = 'block';
    if (rowPanel) rowPanel.style.display = 'none';
    updateRightPanel_list(visibleResults);
    updateRightPanel_rows(visibleResults);
  }

  document.querySelector('.show-image-1').scrollTop = 0;
  document.querySelector('.show-image-2').scrollTop = 0;

  addImageEventListeners();

  // Prefetch is intentionally fire-and-forget so search latency and rendering
  // are unaffected. Use the flattened list for TRAKE and normal rows for KIS/QA.
  if (typeof window.prefetchResultVideos === 'function') {
    window.prefetchResultVideos(data, 20);
  }
  if (typeof window.prefetchBoundaryFrames === 'function') {
    window.prefetchBoundaryFrames(data, 20, 5);
  }
  // Register results for inline OCR/ASR search (inline_search.js)
  if (typeof window.setInlineSearchResults === 'function') {
    window.setInlineSearchResults(data);
  }
}


function addImageEventListeners() {
  document.querySelectorAll('.img-dis img').forEach(img => {
    img.addEventListener('dragstart', drag);
  });

  document.querySelectorAll('.export_icon').forEach(icon => {
    icon.addEventListener('click', (event) => {
      const container = event.target.closest('.img-dis');
      const img = container.querySelector('img');
      const infor = container.querySelector('.infor');
      const [, timestampSeconds] = infor.textContent.split('-');
      addImageToExportArea(timestampSeconds, img.src, infor.textContent);
    });
  });

  // Add middle-click event listener to all relevant containers
  document.querySelectorAll('.img-dis, .frame-container, .preview-image-wrapper, .current-preview-wrapper').forEach(container => {
    container.addEventListener('mousedown', handleMiddleClick);
  });
}


function cleanupSearchResults() {
  // Clear main content areas
  ['list-photo', 'images-rows'].forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      // Remove all observers and event listeners
      element.querySelectorAll('img').forEach(img => imageObserver.unobserve(img));
      element.innerHTML = '';
    }
  });

  // Reset scroll positions
  ['show-image-1', 'show-image-2'].forEach(className => {
    const element = document.querySelector(`.${className}`);
    if (element) element.scrollTop = 0;
  });
}

// ── VIDEO PREVIEW HOVER LOGIC (upgraded) ──
// Uses a SINGLE shared <video> element reused across cards for efficiency.
// Adds a gold progress bar that loops the clip window around the target frame.
const HP = { el: null, card: null, timer: 0, clip: [0, 0] };
const HOVER_DELAY = 220;
const CLIP_BEFORE = 2;   // seconds before frame
const CLIP_AFTER  = 8;   // seconds after frame

function _getHoverVideo() {
  if (HP.el) return HP.el;
  const v = document.createElement('video');
  v.className = 'hover-preview-video';
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.addEventListener('timeupdate', () => {
    const [a, b] = HP.clip;
    // Loop within the clip window
    if (v.currentTime > b || v.currentTime < a - 0.5) v.currentTime = a;
    // Update progress bar
    const bar = HP.card?.querySelector('.hover-progress-bar');
    if (bar) bar.style.width = `${Math.min(100, ((v.currentTime - a) / (b - a)) * 100)}%`;
  });
  v.addEventListener('playing', () => v.classList.add('on'));
  return (HP.el = v);
}

function handleHoverEnter(div, img, result) {
  if (!document.body.classList.contains('enable-hover-video')) return;
  _hoverStop();
  HP.card = div;
  HP.timer = setTimeout(() => {
    if (HP.card !== div) return;
    const t = result.timestamp_seconds || 0;
    HP.clip = [Math.max(0, t - CLIP_BEFORE), t + CLIP_AFTER];
    const v = _getHoverVideo();
    v.classList.remove('on');
    // Inject into card - copy sizing attrs from the thumbnail
    v.dataset.realFrameId = img.dataset.realFrameId;
    v.dataset.timestampSeconds = img.dataset.timestampSeconds;
    div.style.position = 'relative';
    div.appendChild(v);
    // Add progress bar if not already there
    if (!div.querySelector('.hover-progress-bar')) {
      const bar = document.createElement('div');
      bar.className = 'hover-progress-bar';
      div.appendChild(bar);
    }
    v.dataset.play = '1';
    // Build B2 URL for the video
    let batchDir = 'batch1';
    if (window.VIDEO_METADATA && window.VIDEO_METADATA[result.video_id]) {
      batchDir = window.VIDEO_METADATA[result.video_id].batch || 'batch1';
    } else {
      batchDir = result.video_id.startsWith('M') ? 'batch2' : 'batch1';
    }
    const b2VideoPath = `videos/${batchDir}/${result.video_id}.mp4`;
    const src = `${window.BACKEND_BASE || ''}/api/b2_media/${b2VideoPath}`;
    if (v.dataset.v !== result.video_id) {
      v.dataset.v = result.video_id;
      v.src = src;
      v.load();
    }
    const seekAndPlay = () => { v.currentTime = HP.clip[0]; v.play().catch(() => {}); };
    if (v.readyState >= 1) seekAndPlay();
    else v.addEventListener('loadedmetadata', seekAndPlay, { once: true });
  }, HOVER_DELAY);
}

function handleHoverLeave(div) {
  if (HP.card === div) _hoverStop();
}

function _hoverStop() {
  clearTimeout(HP.timer);
  if (HP.card) {
    const bar = HP.card.querySelector('.hover-progress-bar');
    if (bar) bar.style.width = '0';
  }
  if (HP.el) {
    HP.el.dataset.play = '0';
    HP.el.pause();
    HP.el.classList.remove('on');
    HP.el.remove();
  }
  HP.card = null;
}
