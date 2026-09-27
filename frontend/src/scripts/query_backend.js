//------------------------ Search Query (real REST API) ------------------------//
// Calls backend/app.py directly â€” POST /api/search/{kis,qa,trake} on
// window.BACKEND_BASE. No Milvus /TextQuery, no WebSocket, no similarity
// search (that Milvus-only route has no equivalent here).
//
// activeTask ('kis' | 'vqa' | 'trake', set in export.js) picks the
// endpoint. For kis/vqa, every non-empty Text_Query textarea across
// .Search_Scene elements becomes one entry (only the first is actually
// used). For trake, events come from the dedicated N-textarea block in
// src/scripts/trake_events.js instead â€” see setTrakeEventsVisible(),
// which hides/shows the two UIs on task switch.
//
// searchCache/currentAbortController/imageObserver are declared in
// update_result.js (loaded before this file) â€” reused, not redeclared.

function collectSearchQueries() {
  if (activeTask === 'trake' && typeof getTrakeEventQueries === 'function') {
    return getTrakeEventQueries();
  }
  return Array.from(document.querySelectorAll('.Search_Scene textarea[name="Text_Query"]'))
    .map(textarea => textarea.value.trim())
    .filter(query => query.length > 0);
}

// OCR/ASR are selected from the main query in Multi-mode.  A quoted phrase
// is treated as the strongest text hint; if there is no quoted phrase, the
// complete query is passed unchanged.  There are intentionally no extra
// OCR/ASR text boxes in the UI anymore.
function quotedQueryParts(query) {
  const text = String(query || '');
  const matches = [];
  const patterns = [/["“]([^"”]+)["”]/g, /'([^']+)'/g];
  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1].trim();
      if (value) matches.push(value);
    }
  });
  return [...new Set(matches)].join(' ').trim();
}

function getSearchConfigForRequest() {
  if (typeof getSearchConfig === 'function') return getSearchConfig();
  return {
    family: 'standard',
    search_mode: 'standard',
    fusion_mode: 'late',
    multimodal_mode: 'none',
    deepseek_vision: false,
  };
}

function collectOcrAsrQueries(query) {
  const config = getSearchConfigForRequest();
  const quoted = quotedQueryParts(query);
  const base = String(query || '').trim();
  if (config.multimodal_mode === 'visual_ocr') {
    return { ocr_query: quoted || base, asr_query: null };
  }
  if (config.multimodal_mode === 'visual_asr') {
    return { ocr_query: null, asr_query: quoted || base };
  }
  if (config.family === 'standard') {
    // Visual encoders may receive the translated query, while OCR/ASR keep
    // the user's original wording.  This is important for Vietnamese text
    // and speech evidence and costs no extra input field.
    return { ocr_query: base || null, asr_query: base || null };
  }
  // only_visual is explicit. The backend can use this flag to suppress text
  // lanes; null is retained for older servers that do not know the mode yet.
  return { ocr_query: null, asr_query: null };
}

function getSearchMode() {
  return getSearchConfigForRequest().search_mode;
}

async function callSearchAPI(queries, signal, sourceQueries = queries, options = {}) {
  const requestStarted = performance.now();
  let endpoint;
  let body;
  if (activeTask === 'trake') {
    endpoint = 'trake';
    body = { events: queries, top_k_videos: 10 };
    // The normal TRAKE button performs the inexpensive event retrieval.  The
    // explicit DeepSeek button opts into the anchor-locked pass; this keeps
    // the expensive Vision request out of accidental Enter/search clicks.
    if (options.trakeDeepSeek === true && typeof getTrakeManualSearchParams === 'function') {
      const manual = getTrakeManualSearchParams();
      if (manual.anchor_frame_id !== null && !manual.video_id) {
        throw new Error('Anchor frame cần có Anchor video.');
      }
      if (!manual.video_id && !manual.anchor_query) {
        throw new Error('Chọn Anchor video hoặc nhập Anchor query trước khi tìm bằng DeepSeek.');
      }
      if (manual.video_id || manual.anchor_query || manual.anchor_frame_id !== null) {
        body = { ...body, ...manual };
      }
    }
  } else if (activeTask === 'vqa') {
    endpoint = 'qa';
    const config = getSearchConfigForRequest();
    body = {
      question: queries[0],
      top_k: 100,
      // Preserve all ranked frames for the result grid.  Backend-side UI
      // diversification can discard the ground-truth frame when one video
      // contributes several nearby high-scoring frames.
      diversify_for_ui: false,
      search_mode: config.search_mode,
      fusion_mode: config.fusion_mode || 'late',
      multimodal_mode: config.multimodal_mode || 'none',
      deepseek_vision: config.deepseek_vision,
      deepseek_rerank: false,
      ...collectOcrAsrQueries(sourceQueries[0]),
    };
  } else {
    endpoint = 'kis';
    const config = getSearchConfigForRequest();
    body = {
      query: queries[0],
      top_k: 100,
      // Do not cap frames per video before the FE renders the ranked list.
      diversify_for_ui: false,
      search_mode: config.search_mode,
      fusion_mode: config.fusion_mode,
      multimodal_mode: config.multimodal_mode,
      deepseek_vision: config.deepseek_vision,
      ...collectOcrAsrQueries(sourceQueries[0]),
    };
  }

  console.log(`[DEBUG API] Gửi request đến FE endpoint /api/search/${endpoint}`);
  console.log(`[DEBUG API] Payload:`, JSON.stringify(body, null, 2));
  const response = await fetch(`${window.BACKEND_BASE}/api/search/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  const envelope = await response.json();
  const responseReceived = performance.now();
  const parsedAt = performance.now();
  console.debug(`[search-timing] fetch=${(responseReceived-requestStarted).toFixed(1)}ms json=${(parsedAt-responseReceived).toFixed(1)}ms total=${(parsedAt-requestStarted).toFixed(1)}ms endpoint=${endpoint}`);
  console.log(`[DEBUG API] Phản hồi từ /api/search/${endpoint}:`, envelope);
  if (!response.ok || !envelope.success) {
  const parsedAt = performance.now();
    throw new Error(envelope.error || `HTTP ${response.status}`);
  }
  return envelope.data;
}

//------------------------ KIS-V: search by example image ------------------------//
// Confirmed needed for the AIC2026 final round (not the preliminary round,
// which is text/Q&A/TRAKE only â€” see docs/SEARCH_API_RUNBOOK.md). The
// image-upload UI (tab/drag-drop) already existed in scene-1 but was never
// wired to send anything â€” this is that wiring. Multipart, not JSON, since
// the query is a file.

// The image tab/drop-area UI only exists on scene-1 (see index.html) and
// only matters for KIS â€” TRAKE/QA don't have an image input at all.
function getActiveImageFile() {
  if (activeTask !== 'kis') return null;
  const scene = document.getElementById('search-scene-1');
  if (!scene) return null;
  const imageButton = scene.querySelector('.image-button');
  if (!imageButton || !imageButton.classList.contains('active')) return null;
  const fileInput = scene.querySelector('.image-drop-area input[type="file"]');
  return fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
}

async function callSearchByImageAPI(imageFile, signal) {
  const formData = new FormData();
  formData.append('image', imageFile);
  formData.append('top_k', '30');

  console.log(`[DEBUG API] Gửi request tìm kiếm bằng ảnh (File name: ${imageFile.name})`);
  const response = await fetch(`${window.BACKEND_BASE}/api/search/kis_by_image`, {
    method: 'POST',
    body: formData,
    signal,
  });

  const envelope = await response.json();
  console.log(`[DEBUG API] Phản hồi từ /api/search/${endpoint}:`, envelope);
  if (!response.ok || !envelope.success) {
    throw new Error(envelope.error || `HTTP ${response.status}`);
  }
  return envelope.data;
}

const performImageSearch = debounce(async function (imageFile) {
  toggleLoadingIndicator(true);

  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();

  try {
    const results = await callSearchByImageAPI(imageFile, currentAbortController.signal);
    updateUIWithSearchResults(results);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Image search error:', error);
      showToast(`Lá»—i tÃ¬m kiáº¿m báº±ng áº£nh: ${error.message}`, 'error');
    }
  } finally {
    toggleLoadingIndicator(false);
  }
}, 300);

// Perform search with debounce (prevents too many requests)
const performSearch = debounce(async function (queries, options = {}) {
  if (!queries || queries.length === 0) return;

  // Include the selected mode and optional TRAKE anchor in the cache key so
  // changing either one cannot reuse results produced by an older request.
  const config = activeTask === 'kis' ? getSearchConfigForRequest() : {};
  const modalityQueries = activeTask === 'kis'
    ? collectOcrAsrQueries(queries[0]) : {};
  let trakeSelectionKey = '';
  if (activeTask === 'trake' && typeof getTrakeManualSearchParams === 'function') {
    try {
      trakeSelectionKey = JSON.stringify(getTrakeManualSearchParams());
    } catch (error) {
      showToast(error.message, 'error');
      return;
    }
  }
  const cacheKey = `${activeTask}:${JSON.stringify(config)}:${JSON.stringify(options)}:${queries.join('|')}:${JSON.stringify(modalityQueries)}:${trakeSelectionKey}`;
  if (searchCache.has(cacheKey)) {
    updateUIWithSearchResults(searchCache.get(cacheKey));
    return;
  }

  toggleLoadingIndicator(true);

  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();

  try {
    let translatedQueries = queries;
    if (document.getElementById('translate-checkbox').checked) {
      translatedQueries = await Promise.all(queries.map(q => translateText(q)));
    }

    const results = await callSearchAPI(
      translatedQueries,
      currentAbortController.signal,
      queries,
      options,
    );
    searchCache.set(cacheKey, results);
    updateUIWithSearchResults(results);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Search error:', error);
      showToast(`Lá»—i tÃ¬m kiáº¿m: ${error.message}`, 'error');
    }
  } finally {
    toggleLoadingIndicator(false);
  }
}, 300);


// there are some way to query in UI
//----------------------------------------------//
// When start web
// Perform initial search when loading web first time
async function performInitialSearch() {
  // No default query â€” search only runs once the user types something.
}


//-----------------------------------------------//
// Enter-to-search is handled globally in short_cut.js.

// Perform search from text area
async function performSearchFromTextareas(options = {}) {
  // A fresh global search starts a new candidate set.  Do not carry selected
  // video filters from the previous query into this one.
  if (typeof clearSelectedFilterVideos === 'function') {
    clearSelectedFilterVideos();
  }
  if (typeof clearSelectedFilterHistory === 'function') {
    clearSelectedFilterHistory();
  }
  const imageFile = getActiveImageFile();
  if (imageFile) {
    await performImageSearch(imageFile);
    return;
  }

  const queries = collectSearchQueries();
  if (queries.length === 0) {
    toggleLoadingIndicator(false);
    return;
  }
  await performSearch(queries, options);
}

document.getElementById("search-button").addEventListener("click", function(event) {
  event.preventDefault();
  performSearchFromTextareas();
});

document.getElementById("surprise-me-button").addEventListener("click", function(event) {
  event.preventDefault();
  
  if (!window.B2_MAPPING || Object.keys(window.B2_MAPPING).length === 0) {
    if (typeof showToast === 'function') {
      showToast('Đang tải dữ liệu B2 hoặc không có dữ liệu mapping!', 'error');
    }
    return;
  }
  
  const videoIds = Object.keys(window.B2_MAPPING);
  const mockResults = [];
  
  for (let i = 0; i < 40; i++) {
    const randomVideo = videoIds[Math.floor(Math.random() * videoIds.length)];
    // Sinh frame ngẫu nhiên (từ 500 đến khoảng 20000, bắt đúng lưới 5-frame)
    const randomFrameId = Math.floor(Math.random() * 4000) * 5 + 500; 
    
    mockResults.push({
      video_id: randomVideo,
      frame_id: randomFrameId,
      timestamp_seconds: randomFrameId / 25.0, // Giả định 25fps
      score: 1.0,
      frame_exists: true,
      ocr_snippet: '',
      caption_snippet: '🎉 Surprise Random Frame',
      audio_segment_text: ''
    });
  }
  
  if (typeof updateUIWithSearchResults === 'function') {
    updateUIWithSearchResults(mockResults);
    if (typeof showToast === 'function') {
      showToast('Đã sinh 40 frame ngẫu nhiên!', 'success');
    }
  }
});





