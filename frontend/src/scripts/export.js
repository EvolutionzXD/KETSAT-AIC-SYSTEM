//------------------------ Export ------------------------//

// Toggle the visibility of the export area and adjust the width of the content wrapper accordingly.
function toggleExportArea() {
  const exportArea = document.getElementById('export-area');
  const contentWrapper = document.querySelector('.content-wrapper');
  
  exportArea.classList.toggle('show');
  contentWrapper.classList.toggle('export-active');
}

// Initialize event listeners after the DOM content is loaded.
// Add a click event listener to the export button to toggle the export area.
// Handle window resize events to adjust the width of the content wrapper.
document.addEventListener('DOMContentLoaded', function() {
  const exportButton = document.getElementById('export-button');
  exportButton.addEventListener('click', toggleExportArea);
  
  window.addEventListener('resize', function() {
      const exportArea = document.getElementById('export-area');
      const contentWrapper = document.querySelector('.content-wrapper');
      
      if (exportArea.classList.contains('show')) {
          contentWrapper.style.width = '80%';
      }
  });
});

//---------------------------------------------------------------------------------------------//

// Three AIC task types: KIS (find the right video), VQA/QA (video + text
// answer), TRAKE (ordered sequence of moments within one video).
const TASK_TYPES = ['kis', 'vqa', 'trake'];
let activeTask = 'kis';
let vqaInputs = {};

// QA answers are keyed by the complete video/frame pair.  A frame number is
// not globally unique, and `frameId` can be a playback timestamp, so using it
// alone can attach an answer to the wrong row.
function qaInputKey(item) {
  return item?.videoFramePart || String(item?.realFrameId ?? item?.frameId ?? '');
}

function qaInputValue(item) {
  const composite = vqaInputs[qaInputKey(item)];
  if (composite !== undefined) return composite;
  // Backward compatibility with queues created by the previous frontend:
  // older versions keyed by either the real frame or playback timestamp.
  for (const key of [item?.realFrameId, item?.frameId]) {
    if (key !== undefined && vqaInputs[key] !== undefined) return vqaInputs[key];
  }
  return '';
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Toggles between KIS/VQA/TRAKE tasks, updating the UI
function toggleTask(task) {
  activeTask = task;
  const exportImages = document.getElementById('export-images');

  TASK_TYPES.forEach(t => {
    const button = document.getElementById(t);
    const fullscreenButton = document.getElementById(`${t}-fullscreen`);
    button?.classList.toggle('active', t === task);
    fullscreenButton?.classList.toggle('active', t === task);
  });

  exportImages.classList.toggle('vqa-mode', task === 'vqa');
  exportImages.classList.toggle('trake-mode', task === 'trake');

  // Swap the search-form input UI: TRAKE gets its own N-event textarea
  // list instead of the KIS "scene" UI (image tab, Temporal/Expansion,
  // OCR/ASR) — see src/scripts/trake_events.js.
  if (typeof setTrakeEventsVisible === 'function') {
    setTrakeEventsVisible(task === 'trake');
  }

  updateExportArea();
  loadExportContent();
}

//---------------------------------------------------------------------------------------------//
// Export toggle

let exportedImages = [];

// Resets the export area by clearing the list of exported images.
function resetExportArea() {
  exportedImages = [];
  updateExportArea();
  if (typeof broadcastQueueClear === 'function') broadcastQueueClear();
}

// Handles the "drop" event to prevent default behavior (file dragging).
function allowDrop(ev) {
  ev.preventDefault();
}





// Handles the "drop" event to prevent default behavior (file dragging).
function allowDrop(ev) {
  ev.preventDefault();
}


// Update the export area UI with the list of exported images.
function updateExportArea() {
  const exportImages = document.getElementById('export-images');
  
  const htmlContent = exportedImages.map((img, index) => `
    <div class="export-image-container">
      <img src="${img.src}" class="export-image" title="Frame ID: ${img.realFrameId ?? img.frameId}">
      <button class="delete-button" onclick="deleteExportImage(${index})" title="Xóa">×</button>
      <button class="solo-submit-button" onclick="submitSingleImage_v2(${index})" title="Nộp frame này ngay" style="position:absolute; bottom:5px; right:5px; background:var(--primary-color); color:white; border:none; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px; z-index:10;"><i class="fas fa-paper-plane"></i> Gửi</button>
      <div class="infor">${img.frameInfo}</div>
      ${activeTask === 'vqa' ? `
        <input
          type="text"
          class="vqa-input"
          value="${escapeHtmlAttribute(qaInputValue(img))}"
          placeholder="VQA Input"
        >
      ` : ''}
      ${activeTask === 'trake' ? `<div class="event-badge">E${index + 1}</div>` : ''}
    </div>
  `).join('');
  
  exportImages.innerHTML = htmlContent;

  // The compact QA inputs are regenerated on every refresh.  Persist edits
  // immediately so CSV/SOLOAI export reads the value currently on screen.
  exportImages.querySelectorAll('.vqa-input').forEach((input, index) => {
    const item = exportedImages[index];
    input.addEventListener('input', () => {
      vqaInputs[qaInputKey(item)] = input.value;
    });
  });
}

// Updates the VQA input for a specific frame ID in the export area.
function updateVqaInput(frameId, vqaInput) {
  vqaInputs[frameId] = vqaInput;
  updateExportArea();
}

//---------------------------------------------------------------------------------------------//
// Export Logging

// No server-side export log exists in the real API — this used to relay to
// a WebSocket log server that has no equivalent here. Kept as a local
// console record only, so exportToCSV()'s callers don't need changing.
function logExport(fileName, taskType, topImages) {
  console.info('Export:', fileName, taskType, topImages);
}

//---------------------------------------------------------------------------------------------//
// Export to CSV

// Triggers the export process to a CSV file based on the currently active task (KIS or VQA).
function legacyExportToCSV() {
  const fileName = document.getElementById('filenameInput').value || getSuggestedFileName();

  if (activeTask === 'kis') {
    exportKisCSV(fileName);
  } else if (activeTask === 'vqa') {
    exportVqaCSV(fileName);
  } else if (activeTask === 'trake') {
    exportTrakeCSV(fileName);
  }
}

// Export the images to a CSV file, including any necessary additional images
// to reach a total of 100 (top-up pulled from the last search's full result
// set, ranked by score — richer than what's visible in exportedImages).
function legacyExportKisCSV(fileName) {
  const exportData = exportedImages.slice(0, 100);

  if (exportData.length < 100 && Array.isArray(data)) {
    const remainingCount = 100 - exportData.length;
    const sortedResults = [...data].sort((a, b) => b.score - a.score);
    const additionalImages = sortedResults
      .filter(result => !exportedImages.some(img => img.videoFramePart === `${result.video_id}/${result.frame_id}`))
      .slice(0, remainingCount)
      .map(result => ({ videoFramePart: `${result.video_id}/${result.frame_id}` }));
    exportData.push(...additionalImages);
  }

  const csvData = exportData.map(item => item.videoFramePart.split('/').join(','));

  const csvContent = csvData.join('\n');
  downloadCSV(csvContent, fileName);

  const topImages = csvData.slice(0, 5);
  logExport(fileName, 'kis', topImages);
}

function legacyExportVqaCSV(fileName) {
  const csvData = exportedImages.map(item => {
    const [videoName, imageNumber] = item.videoFramePart.split('/');
    const vqaInput = vqaInputs[item.frameId] || '0';
    return `${videoName},${imageNumber},${vqaInput}`;
  });

  const csvContent = csvData.join('\n');
  downloadCSV(csvContent, fileName);

  const topImages = csvData.slice(0, 5);
  logExport(fileName, 'vqa', topImages);
}

// TRAKE: ordered moments (E1, E2, ...) within one video. Row format is
// `videoName,frame1,frame2,...,frameN` in the order frames were added —
// the exact official AIC2026 TRAKE column format is unpublished
// (TODO(AIC2026_SPEC)), so confirm/adjust this once DRES specs land.
function legacyExportTrakeCSV(fileName) {
  const videoOrder = [];
  const framesByVideo = {};

  exportedImages.forEach(item => {
    const [videoName, imageNumber] = item.videoFramePart.split('/');

    if (!framesByVideo[videoName]) {
      framesByVideo[videoName] = [];
      videoOrder.push(videoName);
    }
    framesByVideo[videoName].push(imageNumber);
  });

  const csvData = videoOrder.map(videoName => [videoName, ...framesByVideo[videoName]].join(','));

  const csvContent = csvData.join('\n');
  downloadCSV(csvContent, fileName);

  const topImages = csvData.slice(0, 5);
  logExport(fileName, 'trake', topImages);
}

function downloadCSV(csvContent, fileName) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// SOLOAI export (the original file predates the SOLOAI button and only
// downloaded an ad-hoc CSV).  These definitions intentionally live after the
// legacy helpers so they override them without changing keyboard/plugin APIs.

function normalizedCsvFileName(value) {
  const raw = String(value || '').trim() || getSuggestedFileName();
  // A filename input must not be allowed to escape the selected SOLOAI folder.
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return safe.toLowerCase().endsWith('.csv') ? safe : `${safe}.csv`;
}

function exportError(message) {
  if (typeof showTemporaryAlert === 'function') showTemporaryAlert(message);
  else if (typeof showToast === 'function') showToast(message, 'error');
  else window.alert(message);
  return null;
}

// Queue keys use video_id/frame_id.  The fallback accepts the older display
// label by splitting at its last dash (video IDs contain underscores, not
// dashes in the AIC corpus).
function parseVideoFrame(item) {
  const key = String(item?.videoFramePart || '').trim();
  const slash = key.lastIndexOf('/');
  if (slash > 0) {
    const videoName = key.slice(0, slash);
    const frameId = Number(key.slice(slash + 1).replace(/^f_/, ''));
    if (videoName && Number.isSafeInteger(frameId) && frameId >= 0) {
      return { videoName, frameId };
    }
  }

  const label = String(item?.frameInfo || '').trim();
  const dash = label.lastIndexOf('-');
  if (dash > 0) {
    const videoName = label.slice(0, dash);
    const frameId = Number(label.slice(dash + 1));
    if (videoName && Number.isSafeInteger(frameId) && frameId >= 0) {
      return { videoName, frameId };
    }
  }
  return null;
}

function csvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

// Keep the answer column unambiguous even when the answer has no comma today;
// this also makes answers containing future punctuation safe for CSV readers.
function csvAnswerField(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function exportItemsWithTopUp() {
  const items = exportedImages.slice(0, 100).map(item => ({ ...item }));
  const existing = new Set(items.map(item => item.videoFramePart));

  // KIS traditionally exports up to 100 ranked frames.  Guard the optional
  // global `data` so an export before the first search is a normal validation
  // error, not a ReferenceError.
  if (activeTask === 'kis' && items.length < 100 && Array.isArray(data)) {
    [...data]
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .filter(result => result?.video_id != null && result?.frame_id != null)
      .filter(result => !existing.has(`${result.video_id}/${result.frame_id}`))
      .slice(0, 100 - items.length)
      .forEach(result => {
        const key = `${result.video_id}/${result.frame_id}`;
        existing.add(key);
        items.push({
          videoFramePart: key,
          frameInfo: `${result.video_id}-${result.frame_id}`,
          realFrameId: Number(result.frame_id),
        });
      });
  }
  return items;
}

function buildCsvExport() {
  const items = exportItemsWithTopUp();
  if (!items.length) return exportError('Chưa có frame nào để lưu/xuất.');

  if (activeTask === 'kis') {
    const rows = [];
    for (const item of items) {
      const parsed = parseVideoFrame(item);
      if (!parsed) return exportError('Có frame_id không hợp lệ trong danh sách KIS.');
      rows.push(`${csvField(parsed.videoName)},${parsed.frameId}`);
    }
    return { content: rows.join('\r\n'), items, task: 'kis' };
  }

  if (activeTask === 'vqa') {
    const rows = [];
    for (const item of items.slice(0, 100)) {
      const parsed = parseVideoFrame(item);
      if (!parsed) return exportError('Có frame_id không hợp lệ trong danh sách QA.');
      const answer = String(qaInputValue(item)).trim();
      if (!answer) {
        return exportError(`Chưa nhập câu trả lời cho ${parsed.videoName}-${parsed.frameId}.`);
      }
      if (answer.length > 100) {
        return exportError(`Câu trả lời cho ${parsed.videoName}-${parsed.frameId} không được vượt quá 100 ký tự.`);
      }
      rows.push(`${csvField(parsed.videoName)},${parsed.frameId},${csvAnswerField(answer)}`);
    }
    return { content: rows.join('\r\n'), items: items.slice(0, 100), task: 'vqa' };
  }

  // TRAKE preserves insertion order and emits one row per video.  A valid
  // contest query normally has one video; grouping prevents mixed queues from
  // silently interleaving frames.
  const expectedEvents = Number(document.getElementById('Trake-Event-Count')?.value || 0);
  if (Number.isInteger(expectedEvents) && expectedEvents > 0 && items.length !== expectedEvents) {
    return exportError(`TRAKE cần đúng ${expectedEvents} frame theo số sự kiện (hiện có ${items.length}).`);
  }
  const videoOrder = [];
  const framesByVideo = new Map();
  for (const item of items.slice(0, 100)) {
    const parsed = parseVideoFrame(item);
    if (!parsed) return exportError('Có frame_id không hợp lệ trong danh sách TRAKE.');
    if (!framesByVideo.has(parsed.videoName)) {
      framesByVideo.set(parsed.videoName, []);
      videoOrder.push(parsed.videoName);
    }
    framesByVideo.get(parsed.videoName).push(parsed.frameId);
  }
  const rows = videoOrder.map(video =>
    [csvField(video), ...framesByVideo.get(video)].join(',')
  );
  return { content: rows.join('\r\n'), items, task: 'trake' };
}

// Override the legacy dispatcher while retaining its original public names.
function exportToCSV(fileName) {
  const prepared = buildCsvExport();
  if (!prepared) return false;
  // Callers from the compact export UI historically invoke this without an
  // argument after filling #filenameInput.  Honor that field before falling
  // back to the task-based default, while still sanitizing the final name.
  const requestedName = fileName || document.getElementById('filenameInput')?.value;
  const normalizedName = normalizedCsvFileName(requestedName);
  downloadCSV(prepared.content, normalizedName);
  logExport(normalizedName, prepared.task, prepared.content.split(/\r?\n/).slice(0, 5));
  return true;
}

function exportKisCSV(fileName) { return exportToCSV(fileName); }
function exportVqaCSV(fileName) { return exportToCSV(fileName); }
function exportTrakeCSV(fileName) { return exportToCSV(fileName); }

function soloaiPayload(prepared, fileName) {
  const items = prepared.items.map(item => {
    const parsed = parseVideoFrame(item);
    return parsed ? { video_id: parsed.videoName, frame_id: parsed.frameId } : null;
  }).filter(Boolean);
  const answers = prepared.task === 'vqa'
    ? prepared.items.map(item => String(qaInputValue(item)).trim())
    : [];
  return {
    query_filename: normalizedCsvFileName(fileName),
    task: prepared.task,
    content: prepared.content,
    items,
    answers,
    answer: answers.join(', '),
  };
}

let soloaiDirectoryHandle = null;

async function writeLocalSoloaiFile(fileName, content) {
  // Chromium's File System Access API is the browser-safe way to write into a
  // user-selected SOLOAI folder.  It must run directly from the click event.
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      // Reuse the directory handle for the current page session so 24 query
      // files do not open 24 folder dialogs.  A reload asks once again.
      const directory = soloaiDirectoryHandle ||
        await window.showDirectoryPicker({ mode: 'readwrite' });
      soloaiDirectoryHandle = directory;
      const handle = await directory.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return { method: 'directory', directory: directory.name };
    } catch (error) {
      // User cancellation is normal; fall through to a download so no answer
      // disappears silently.
      soloaiDirectoryHandle = null;
      if (error?.name !== 'AbortError') console.warn('SOLOAI folder write failed:', error);
    }
  }
  downloadCSV(content, fileName);
  return { method: 'download' };
}

async function saveSoloaiSubmission() {
  const prepared = buildCsvExport();
  if (!prepared) return false;
  const fileName = normalizedCsvFileName(document.getElementById('filenameInput')?.value);
  const payload = soloaiPayload(prepared, fileName);
  const button = document.getElementById('save-solo-btn');
  if (button) button.disabled = true;

  try {
    // The backend route writes to its configured SOLOAI_OUTPUT_DIR (UIT:
    // /home/bachdx/SOLOAI). Static deployments receive 404/405 and use the
    // local-folder/download path below.
    // Enable only when the deployment explicitly exposes the server route;
    // probing it first would consume the user-activation token required by
    // showDirectoryPicker().
    if (window.SOLOAI_SERVER_SAVE === true && window.BACKEND_BASE) {
      try {
        const response = await fetch(`${window.BACKEND_BASE}/api/submission/solo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (response.ok) {
          const result = await response.json().catch(() => ({}));
          // FastAPI responses are enveloped under `data`; retain compatibility
          // with a direct payload if a proxy strips the envelope.
          const saved = result && result.data ? result.data : result;
          document.getElementById('exportModal').style.display = 'none';
          const message = `Đã lưu SOLOAI: ${(saved && saved.output_filename) || fileName}`;
          if (typeof showTemporaryAlert === 'function') showTemporaryAlert(message);
          else if (typeof showToast === 'function') showToast(message);
          return true;
        }
        if (![404, 405].includes(response.status)) {
          const detail = await response.json().catch(() => ({}));
          const message = detail.detail || `SOLOAI server save failed (${response.status})`;
          exportError(message);
          return false;
        }
      } catch (error) {
        console.warn('SOLOAI server save unavailable, using local save:', error);
      }
    }

    const result = await writeLocalSoloaiFile(fileName, prepared.content);
    document.getElementById('exportModal').style.display = 'none';
    const message = result.method === 'directory'
      ? `Đã lưu ${fileName} vào thư mục ${result.directory}.`
      : `Đã tạo ${fileName}; hãy đặt file vào thư mục SOLOAI.`;
    if (typeof showTemporaryAlert === 'function') showTemporaryAlert(message);
    else if (typeof showToast === 'function') showToast(message);
    return true;
  } finally {
    if (button) button.disabled = false;
  }
}


// Delete an image from the export area and update the UI.
function deleteExportImage(index) {
  const [removed] = exportedImages.splice(index, 1);
  updateExportArea();
  if (removed && typeof broadcastQueueRemove === 'function') broadcastQueueRemove(removed);
}


// Add drag event listeners to image elements in the right panel.
function addDragListeners() {
  document.querySelectorAll('.right-panel .img-dis img, .frame-container img, .preview-image-wrapper img, .current-preview-wrapper img').forEach(img => {
    img.setAttribute('draggable', 'true');
    img.addEventListener('dragstart', drag);
  });
}


// Initialize additional event listeners after the DOM content is loaded.
// Add event listeners for buttons, drag-and-drop functionality, and window resize events.
document.addEventListener('DOMContentLoaded', function() {
  // Get DOM elements
  const exportButton = document.getElementById('export-button');
  // const submitButton = document.getElementById('submit-button');
  const exportArea = document.getElementById('export-area');
  const openExportButton = document.getElementById('open-export');
  const resetExportButton = document.getElementById('reset-export');
  const kisButton = document.getElementById('kis');
  const vqaButton = document.getElementById('vqa');
  const trakeButton = document.getElementById('trake');
  const contentWrapper = document.querySelector('.content-wrapper');

  // Add event listeners
  // exportButton listener is already set up above via toggleExportArea
  openExportButton.addEventListener('click', toggleExportArea);
  // submitButton.addEventListener('click', exportToCSV);
  exportArea.addEventListener('dragover', allowDrop);
  exportArea.addEventListener('drop', drop);
  resetExportButton.addEventListener('click', resetExportArea);
  kisButton.addEventListener('click', () => toggleTask('kis'));
  vqaButton.addEventListener('click', () => toggleTask('vqa'));
  trakeButton.addEventListener('click', () => toggleTask('trake'));

  // Add drag listeners to images
  addDragListeners();

  // Handle window resize
  window.addEventListener('resize', function() {
    if (exportArea.classList.contains('show')) {
      contentWrapper.style.width = '80%';
    }
  });
});


//---------------------------------------------------------------------------------------------//

// Open the export area if it is closed
function openExportAreaIfClosed() {
  const exportArea = document.getElementById('export-area');
  const contentWrapper = document.querySelector('.content-wrapper');
  
  if (!exportArea.classList.contains('show')) {
    exportArea.classList.add('show');
    contentWrapper.classList.add('export-active');
    contentWrapper.style.width = '80%';
  }
}


// addImageToExportArea is defined below with isExportShared support (see line ~635)


// Handle middle mouse button click on an image to add it to the export area.
function handleMiddleClick(event) {
  if (event.button === 1) { // Middle mouse button
    event.preventDefault();
    const container = event.target.closest('.img-dis, .frame-container, .preview-image-wrapper, .current-preview-wrapper');
    if (container) {
      const imgElement = container.querySelector('img');
      const inforElement = container.querySelector('.infor');
      if (imgElement && inforElement) {
        // .infor's text is "video_id-frame_id" (display label) — the
        // seconds value DRES submission needs comes from a dedicated data
        // attribute, never parsed out of the display string (see
        // update_result.js's frameInfoText).
        const frameId = imgElement.dataset.timestampSeconds;
        const imageSrc = imgElement.src;
        addImageToExportArea(frameId, imageSrc, inforElement.textContent, true, imgElement.dataset.realFrameId);
      }
    }
  }
}


//-----------------------------------------------------------------------//
// Drag - drop image in list photo and frame container

function drag(ev) {
  ev.stopPropagation();

  const imgElement = ev.target;
  let frameId, imageSrc, frameInfo;

  const container = imgElement.closest('.img-dis, .frame-container, .preview-image-wrapper, .current-preview-wrapper');

  if (container) {
    const inforElement = container.querySelector('.infor');
    if (inforElement) {
      frameInfo = inforElement.textContent;
      // See handleMiddleClick above: .infor shows "video_id-frame_id" for
      // display; DRES's seconds value lives in a dedicated data attribute.
      frameId = imgElement.dataset.timestampSeconds;
      imageSrc = imgElement.src;

      ev.dataTransfer.setData('application/json', JSON.stringify({
        type: 'image',
        frameId: frameId,
        realFrameId: imgElement.dataset.realFrameId,
        imageSrc: imageSrc,
        frameInfo: frameInfo
      }));
    } else {
      console.error('Info element not found');
    }
  } else {
    console.error('Container not found');
  }
}

let isImageDragging = false;

function drop(ev) {
  ev.preventDefault();
  if (isImageDragging) return;
  isImageDragging = true;

  const data = ev.dataTransfer.getData('application/json');
  
  if (data) {
    try {
      const parsedData = JSON.parse(data);
      
      if (parsedData.type === 'image' && parsedData.frameId && parsedData.imageSrc) {
        addImageToExportArea(parsedData.frameId, parsedData.imageSrc, parsedData.frameInfo, true, parsedData.realFrameId);
      } else {
        console.error('Invalid data format');
      }
    } catch (error) {
      console.error('Error parsing dropped data:', error);
    }
  }

  setTimeout(() => { isImageDragging = false; }, 100);
}



//-----------------------------------------------------------------------//
// Export full screen

// Function to show the fullscreen overlay
function showExportFullscreen() {
  document.getElementById('export-fullscreen-overlay').style.display = 'block';
  loadExportContent();
}

// Function to hide the fullscreen overlay
function hideExportFullscreen() {
  document.getElementById('export-fullscreen-overlay').style.display = 'none';
  openExportAreaIfClosed();
}

// Function to load export content
function loadExportContent() {
  const exportFullscreenContent = document.getElementById('export-fullscreen-content');
  exportFullscreenContent.innerHTML = '';

  if (activeTask === 'kis') {
    // console.log('kis content loading');
    exportedImages.forEach(img => {
      const container = document.createElement('div');
      container.className = 'export-item';

      const imgElement = document.createElement('img');
      imgElement.src = img.src;
      imgElement.alt = `Frame ID: ${img.realFrameId ?? img.frameId}`;

      const infoElement = document.createElement('div');
      infoElement.className = 'info';
      infoElement.textContent = img.frameInfo;

      container.appendChild(imgElement);
      container.appendChild(infoElement);
      exportFullscreenContent.appendChild(container);
    });
  } else if (activeTask === 'vqa') {
    // console.log('vqa content loading');
    exportedImages.forEach(img => {
      const container = document.createElement('div');
      container.className = 'export-item';

      const imgElement = document.createElement('img');
      imgElement.src = img.src;
      imgElement.alt = `Frame ID: ${img.realFrameId ?? img.frameId}`;

      const infoElement = document.createElement('div');
      infoElement.className = 'info';
      infoElement.textContent = img.frameInfo;

      const vqaInput = document.createElement('input');
      vqaInput.type = 'text';
      vqaInput.className = 'vqa-input';
      vqaInput.value = qaInputValue(img);
      vqaInput.placeholder = 'VQA Input';
      vqaInput.oninput = (e) => {
        vqaInputs[qaInputKey(img)] = e.target.value;
      };

      container.appendChild(imgElement);
      container.appendChild(infoElement);
      container.appendChild(vqaInput);
      exportFullscreenContent.appendChild(container);
    });
  } else if (activeTask === 'trake') {
    exportedImages.forEach((img, index) => {
      const container = document.createElement('div');
      container.className = 'export-item';

      const imgElement = document.createElement('img');
      imgElement.src = img.src;
      imgElement.alt = `Frame ID: ${img.realFrameId ?? img.frameId}`;

      const infoElement = document.createElement('div');
      infoElement.className = 'info';
      infoElement.textContent = img.frameInfo;

      const badgeElement = document.createElement('div');
      badgeElement.className = 'event-badge';
      badgeElement.textContent = `E${index + 1}`;

      container.appendChild(imgElement);
      container.appendChild(infoElement);
      container.appendChild(badgeElement);
      exportFullscreenContent.appendChild(container);
    });
  }
}


// Event listeners for kis fullscreen and vqa fullscreen
document.getElementById('kis-fullscreen').addEventListener('click', () => {
  toggleTask('kis');
});

document.getElementById('vqa-fullscreen').addEventListener('click', () => {
  toggleTask('vqa');
});

document.getElementById('trake-fullscreen').addEventListener('click', () => {
  toggleTask('trake');
});


document.getElementById('reset-export-fullscreen').addEventListener('click', () => {
  document.getElementById('export-fullscreen-content').innerHTML = '';
  resetExportArea()
});

document.getElementById('close-export-fullscreen').addEventListener('click', hideExportFullscreen);

// Add event listener to the open-export button
document.getElementById('open-export').addEventListener('click', showExportFullscreen);


// Function to check if the export fullscreen overlay is visible
function isExportFullscreenVisible() {
  return document.getElementById('export-fullscreen-overlay').style.display === 'block';
}

// Event listener for the 'Escape' key
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isExportFullscreenVisible()) {
    hideExportFullscreen();
  }
});



//-----------------------------------------------------------------------//

function getSuggestedFileName() {
  if (activeTask === 'kis') {
    return 'query-p3--kis.csv';
  } else if (activeTask === 'vqa') {
    return 'query-p3--qa.csv';
  } else if (activeTask === 'trake') {
    return 'query-p3--trake.csv';
  }
}

// Hiển thị exportModal khi nhấn nút submit trên thanh header
document.getElementById('submit-button').addEventListener('click', function() {
  // const filenameInput = document.getElementById('filenameInput');
  // filenameInput.value = getSuggestedFileName();

  // document.getElementById('exportModal').style.display = 'block';
  submit_to_dres_v2()
});

// Hiển thị exportModal khi nhấn nút submit ở fullscreen
document.getElementById('submit-fullscreen-button').addEventListener('click', function() {
  // Gợi ý tên file vào input
  const filenameInput = document.getElementById('filenameInput');
  filenameInput.value = getSuggestedFileName();

  // Hiển thị modal
  document.getElementById('exportModal').style.display = 'block';
});

// Đóng modal khi người dùng nhấn cancel
document.querySelector('.export-modal-btn.cancel').addEventListener('click', function() {
  document.getElementById('exportModal').style.display = 'none';
});

// Xử lý xuất file khi người dùng nhấn confirm
document.querySelector('.export-modal-btn.confirm').addEventListener('click', function() {
  const fileName = document.getElementById('filenameInput').value;

  if (exportToCSV(fileName)) {
    document.getElementById('exportModal').style.display = 'none';
  }
});

// The CSV button in the compact export drawer used to have no listener, so
// operators could only reach the modal from the fullscreen view.
function openCsvExportModal() {
  const filenameInput = document.getElementById('filenameInput');
  if (!filenameInput) return;
  filenameInput.value = getSuggestedFileName();
  document.getElementById('exportModal').style.display = 'block';
  filenameInput.focus();
  filenameInput.select();
}

document.getElementById('submit-export-button')?.addEventListener('click', openCsvExportModal);

// Save the exact same validated CSV as the normal download.  The handler is
// intentionally frontend-only: it can use the optional server route when a
// deployment exposes it, or write to a user-selected local SOLOAI folder.
document.getElementById('save-solo-btn')?.addEventListener('click', saveSoloaiSubmission);



//------------------------------------------------------------------------------------------------------------------------------//
//------------------------------------------------------------------------------------------------------------------------------//
//------------------------------------------------------------------------------------------------------------------------------//
// Open or close door share image mode


// Add this at the beginning of your JavaScript file
let isExportShared = true;

// Function to toggle export mode
function toggleExportMode() {
  const openExportSocketButton = document.getElementById('open-export-socket');
  isExportShared = !isExportShared;
  
  if (isExportShared) {
    openExportSocketButton.innerHTML = '<img src="src/Img/icon-door-open.png" alt="icon">';
    openExportSocketButton.title = 'Switch to private mode';
  } else {
    openExportSocketButton.innerHTML = '<img src="src/Img/icon-door-close.png" alt="icon">';
    openExportSocketButton.title = 'Switch to shared mode';
  }
}


// Modify the addImageToExportArea function
// frameId here is the video's TIMESTAMP IN SECONDS (needed for the *1000 ms
// conversion in submit_dres.js), not the real integer frame number — kept
// as-is for backward compatibility with the dedup key / vqaInputs keying.
// realFrameId (optional) is the actual backend frame_id, carried through
// separately purely for display ("Frame ID: ${...}" below) so that label
// shows a real frame number instead of a seconds value mislabeled as one.
function addImageToExportArea(frameId, imageSrc, frameInfo, shouldBroadcast = true, realFrameId = null) {
  frameId = parseFloat(frameId);
  const explicitFrame = realFrameId != null ? Number(realFrameId) : NaN;
  const label = String(frameInfo || '').trim();
  const labelDash = label.lastIndexOf('-');
  const labelVideo = labelDash > 0 ? label.slice(0, labelDash) : '';
  const labelFrame = labelDash > 0 ? Number(label.slice(labelDash + 1)) : NaN;
  const pathParts = String(imageSrc || '').split('/');
  const pathVideo = pathParts.length > 1 ? pathParts[pathParts.length - 2] : '';
  const pathStem = (pathParts[pathParts.length - 1] || '').split(/[?#]/)[0].split('.')[0];
  const pathFrame = Number(pathStem.replace(/^f_/, ''));
  const canonicalFrame = Number.isSafeInteger(explicitFrame) && explicitFrame >= 0
    ? explicitFrame
    : Number.isSafeInteger(labelFrame) && labelFrame >= 0
      ? labelFrame
      : Number.isSafeInteger(pathFrame) && pathFrame >= 0 ? pathFrame : null;
  const videoName = labelVideo || pathVideo;
  const videoFramePart = videoName && canonicalFrame != null
    ? `${videoName}/${canonicalFrame}`
    : '';

  if (!videoFramePart) {
    console.error('Invalid video/frame metadata:', { frameId, realFrameId, frameInfo, imageSrc });
    return;
  }

  const existingImageIndex = exportedImages.findIndex(img => img.videoFramePart === videoFramePart);

  if (existingImageIndex === -1) {
    const newItem = {
      frameId,
      realFrameId: canonicalFrame,
      videoFramePart,
      src: imageSrc,
      frameInfo,
    };
    exportedImages.push(newItem);
    openExportAreaIfClosed();
    updateExportArea();
    if (shouldBroadcast && typeof broadcastQueueAdd === 'function') broadcastQueueAdd(newItem);

    if (isExportShared && shouldBroadcast && socket_share && socket_share.readyState === WebSocket.OPEN) {
      const message = JSON.stringify({
        type: 'image_share',
        frameId: frameId,
        realFrameId: realFrameId,
        src: imageSrc,
        frameInfo: frameInfo
      });
      socket_share.send(message);
    }
  } else {
    console.log('Image already exists in the export area');
  }
}


// Add this to your DOMContentLoaded event listener
document.addEventListener('DOMContentLoaded', function() {
  const openExportSocketButton = document.getElementById('open-export-socket');
  openExportSocketButton.addEventListener('click', toggleExportMode);
});


// socket_share.onmessage is handled in web_socket.js with isExportShared check



// //------------------------------------------------------------------------------------------------------------------------------//
// //------------------------------------------------------------------------------------------------------------------------------//
// //------------------------------------------------------------------------------------------------------------------------------//
// //------------------------------------------------------------------------------------------------------------------------------//




// function getFirstResultForKIS(){
//   console.log(exportedImages)
//   return exportedImages[0]
// }

// function getFirstResultForVQA(){
//   const vqa=document.getElementsByClassName("vqa-input") 
//   return [exportedImages[0],vqa[0].value]
// }



// async function submit_to_dres(){
//   let frame_info=0
//   if (activeTask=="kis"){
//   frame_info= getFirstResultForKIS()
//   } else{
//   frame_info= getFirstResultForVQA()  
//   }
//   const item=frame_info.frameInfo.split('-')[0];
//   const frame= parseInt(frame_info.frameId)*1000;
//   const sessionID=localStorage.getItem('sessionId');
//   const url= `http://192.168.20.164:5000/api/v1/submit?item=${item}&frame=${frame}&session=${sessionID}`
//   const result = await fetch(url, {
//     method: "GET",
//   })
//   .then(response => {
//     if (!response.ok) {
//       // If the response status is 401 (Unauthorized)
//       if (response.status === 401) {
//         alert("Unauthorized access. Please check your credentials.");
//       } 
//       // If the response status is 404 (Not Found)
//       else if (response.status === 404) {
//         alert("WRONG!!");
//       } 
//       // Other possible errors
//       else {
//         alert(`Error: ${response.status}`);
//       }
//       throw new Error(`HTTP status code ${response.status}`);
//     }
//     return response.json();
//   })
//   .then(data => {
//     console.log('Success:', data);
//     // Process data
//   })
//   .catch(error => {
//     console.error('Error:', error);
//   });
// }

// function submit_to_dres_but_dare_devil(item, frame){
//   const url= `http://192.168.20.164:6001/api/v1/submit?item=${item}&frame=${frame}`
//   console.log(url)
//   fetch(url, {
//     method: "GET",
//   });
// }


// async function submit_to_dres_v2(){
//     let frame_info=0

//     const evaluationID = localStorage.getItem('evaluationID');
//     const contestSessionID = localStorage.getItem('contestSessionID');
//     const contestURL=`https://eventretrieval.one/api/v2/submit/${evaluationID}?session=${contestSessionID}`;

//     if (activeTask=="kis"){
//     const frame_info= getFirstResultForKIS()
//     const item=frame_info.frameInfo.split('-')[0];
//     const frame= parseFloat(frame_info.frameId.toFixed(2))*1000.0;
//     const contestresult= await fetch(contestURL,{
//       method:"POST",
//       body:JSON.stringify({"answerSets": [{
//         "answers": [
//         {
//           "mediaItemName": item,
//           "start": frame,
//           "end": frame
//         }]
//       }]
//      })
//     }).then()
//     } else{
//     const frame_info= getFirstResultForVQA() 
//     const item=frame_info[0].frameInfo.split('-')[0];
//     const answer_vqa= frame_info[1]
//     const frame= parseFloat(frame_info[0].frameId.toFixed(2))*1000.0;
//     const contestresult= await fetch(contestURL,{
//       method:"POST",
//       body:JSON.stringify({"answerSets": [{
//         "answers": [
//         {
//           "text": `${answer_vqa}-${item}-${frame}`
//         }]
//       }]
//      })
//     }).then()
//     }
// }

//------------------------------------------------------------------------------------------------------------------------------//
// Video Modal Frame Calculator Logic
//------------------------------------------------------------------------------------------------------------------------------//
(function initVideoCalc() {
  const vidDetails = document.getElementById('vid_details');
  const vcalcVideoId = document.getElementById('vcalc-video-id');
  const vcalcCurrentTime = document.getElementById('vcalc-current-time');
  const vcalcFrameIndex = document.getElementById('vcalc-frame-index');
  const vcalcAddBtn = document.getElementById('vcalc-add-btn');

  if (!vidDetails || !vcalcAddBtn) return;

  let currentVideoId = '';
  let fpsMetadata = null;
  let fpsLoadPromise = null;

  // FPS comes from backend metadata; the removed manual FPS input must not
  // be dereferenced or silently replaced by a hardcoded value.
  async function loadFpsMetadata() {
    if (fpsMetadata) return fpsMetadata;
    if (!fpsLoadPromise) {
      if (typeof fetch !== 'function') return null;
      const base = window.BACKEND_BASE || window.location?.origin || '';
      fpsLoadPromise = fetch(`${base}/api/video-fps`, { cache: 'no-store' })
        .then(response => response.ok ? response.json() : null)
        .catch(() => null)
        .then(value => {
          if (value && (value.overrides || Number.isFinite(Number(value.default_fps)))) {
            fpsMetadata = value;
          }
          return fpsMetadata;
        });
    }
    return fpsLoadPromise;
  }

  function fpsForVideo(videoId) {
    if (!fpsMetadata || !videoId) return null;
    const override = fpsMetadata.overrides?.[videoId];
    const fps = Number(override ?? fpsMetadata.default_fps);
    return Number.isFinite(fps) && fps > 0 ? fps : null;
  }

  // Update whenever video is loaded or playing
  vidDetails.addEventListener('loadedmetadata', updateCalcDisplay);
  vidDetails.addEventListener('timeupdate', updateCalcDisplay);
  loadFpsMetadata().then(updateCalcDisplay).catch(() => {});

  function updateCalcDisplay() {
    // Prefer the globally stored video ID set by show_video.js
    if (window.current_active_video_id) {
      currentVideoId = window.current_active_video_id;
    }
    vcalcVideoId.textContent = currentVideoId || 'Đang tải...';

    const time = vidDetails.currentTime;
    const fps = fpsForVideo(currentVideoId);
    const frameIndex = fps == null ? null : Math.round(time * fps);

    vcalcCurrentTime.textContent = time.toFixed(2);
    vcalcFrameIndex.textContent = frameIndex == null ? '—' : frameIndex;
    vcalcAddBtn.disabled = frameIndex == null || !currentVideoId;
  }

  // Handle Add button — registered exactly once
  vcalcAddBtn.addEventListener('click', async function() {
    // Re-read latest values
    if (window.current_active_video_id) currentVideoId = window.current_active_video_id;

    await loadFpsMetadata();
    const time = vidDetails.currentTime;
    const fps = fpsForVideo(currentVideoId);
    if (fps == null) {
      if (typeof showToast === 'function') {
        showToast('Chưa tải được FPS metadata của video, chưa thể trích frame.');
      }
      return;
    }
    const frameIndex = Math.round(time * fps);

    if (!currentVideoId || currentVideoId === 'Đang tải...' || currentVideoId === 'Unknown') {
      alert('Chưa xác định được Video ID, vui lòng đợi video load!');
      return;
    }

    const frameInfo = `${currentVideoId}-${frameIndex}`;

    // Build proper backend URL so the thumbnail renders correctly in the export area
    const imageSrc = (window.BACKEND_BASE || 'http://192.168.20.156:8602')
      + `/api/frames/${currentVideoId}/${frameIndex}`;

    // Add directly to export area (DRES submit list)
    addImageToExportArea(time, imageSrc, frameInfo, true, frameIndex);

    // Toast notification
    if (typeof showToast === 'function') {
      showToast(`Đã thêm: ${frameInfo} @ ${time.toFixed(2)}s`);
    }
  });
})();

// Helper function to show notifications (Toast)
function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast show';
  toast.innerHTML = `<i class="fas fa-info-circle" style="margin-right: 8px;"></i> ${message}`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (container.contains(toast)) container.removeChild(toast);
    }, 300);
  }, 3000);
}

