//------------------------ Show videoframe ------------------------//

// Global variable to store the frame list
let globalFrameList = [];
let globalSecondList =[];
const videoFrameTimelineCache = new Map();
let currentFrameStripVideo = '';
let currentFrameStripView = 'boundaries';
const boundaryPrefetchState = {
  controller: null,
  warmedImages: new Set(),
};

// Warm KCP boundary metadata for the first 20 distinct result videos and five
// boundary thumbnails nearest each result frame. This keeps right-click scene
// navigation responsive without pulling every boundary image from NFS.
window.prefetchBoundaryFrames = function(results, videoLimit = 20, framesPerVideo = 5) {
  const representatives = new Map();
  for (const row of Array.isArray(results) ? results : []) {
    const videoId = String(row?.video_id || '').trim();
    const frameId = Number(row?.frame_id);
    if (!/^L\d+_V\d+$/.test(videoId) || representatives.has(videoId)) continue;
    representatives.set(videoId, Number.isFinite(frameId) ? frameId : 0);
    if (representatives.size >= videoLimit) break;
  }

  if (boundaryPrefetchState.controller) boundaryPrefetchState.controller.abort();
  const controller = new AbortController();
  boundaryPrefetchState.controller = controller;
  const videos = [...representatives.entries()];
  const imageQueue = [];

  const timelineWorker = async () => {
    while (videos.length && !controller.signal.aborted) {
      const [videoId, targetFrame] = videos.shift();
      const cacheKey = `${videoId}:boundaries`;
      let cached = videoFrameTimelineCache.get(cacheKey);
      if (!cached) {
        try {
          const response = await fetch(
            `${window.BACKEND_BASE}/api/videos/${encodeURIComponent(videoId)}/frames?view=boundaries`,
            { cache: 'force-cache', signal: controller.signal, priority: 'low' }
          );
          const envelope = await response.json();
          if (!response.ok || !envelope.success || !Array.isArray(envelope.data)) continue;
          const frameIds = envelope.data.map(item => Number(item.frame_id)).filter(Number.isFinite);
          const timestamps = envelope.data.reduce((out, item) => {
            const frameId = Number(item.frame_id);
            const seconds = Number(item.timestamp_seconds);
            if (Number.isFinite(frameId) && Number.isFinite(seconds)) out[String(frameId)] = seconds;
            return out;
          }, {});
          cached = { frameIds, timestamps };
          videoFrameTimelineCache.set(cacheKey, cached);
        } catch (error) {
          if (error?.name !== 'AbortError') console.debug(`[boundary-prefetch] ${videoId} skipped`, error);
          continue;
        }
      }

      cached.frameIds
        .slice()
        .sort((a, b) => Math.abs(a - targetFrame) - Math.abs(b - targetFrame))
        .slice(0, framesPerVideo)
        .forEach(frameId => imageQueue.push({ videoId, frameId }));
    }
  };

  const run = async () => {
    await Promise.all([timelineWorker(), timelineWorker(), timelineWorker()]);
    const imageWorker = async () => {
      while (imageQueue.length && !controller.signal.aborted) {
        const { videoId, frameId } = imageQueue.shift();
        const key = `${videoId}:${frameId}`;
        if (boundaryPrefetchState.warmedImages.has(key)) continue;
        await new Promise(resolve => {
          const image = new Image();
          image.onload = image.onerror = resolve;
          image.src = typeof frameImageUrl === 'function'
            ? frameImageUrl(videoId, frameId)
            : `${window.BACKEND_BASE}/api/frames/${videoId}/${frameId}`;
        });
        boundaryPrefetchState.warmedImages.add(key);
      }
    };
    await Promise.all([imageWorker(), imageWorker(), imageWorker(), imageWorker()]);
  };
  run().catch(() => {});
};

// Display video frames and set up the UI
async function showVideoFrames(imgDiv) {
  // Get the container for video frames
  const divVideoFrames = document.getElementById('video-frames');
  const leftPanel = document.querySelector('.left-panel');
  const rightPanel = document.querySelector('.right-panel');

  // Show the video frames
  divVideoFrames.style.display = 'flex';
  document.body.classList.add('frame-strip-open');

  // Panel heights are controlled by responsive_video.css.
  leftPanel.style.height = '';
  rightPanel.style.height = '';

  // Add necessary child elements
  divVideoFrames.innerHTML = `
    <div class="frames-container"></div>
    <div class="navigation-buttons">
      <div class="nav-row">
        <button class="nav-button" id="prev-button" title="Chuyển tới keyframe trước">← Trước</button>
        <button class="nav-button" id="next-button" title="Chuyển tới keyframe sau">Sau →</button>
      </div>
      <div class="nav-row">
        <button class="nav-button" id="show-preview-button" title="Hiện frame đang chọn ở khung xem lớn">↑ Xem lớn</button>
        <button class="nav-button" id="hide-preview-button" title="Ẩn khung xem lớn">↓ Ẩn xem</button>
      </div>
      <button class="nav-button" id="toggle-frame-view-button">Chi tiết scene</button>
      <button class="close-button" title="Đóng dải keyframe">×</button>
    </div>
  `;
  
  const framesContainer = divVideoFrames.querySelector('.frames-container');

  const exportArea = document.getElementById('export-area');
  exportArea.addEventListener('dragover', allowDrop);
  exportArea.addEventListener('drop', drop);

  
  // Get the image from the clicked div
  const img = imgDiv.querySelector('img');
  if (img) {
    const imgPath = img.src;
    const infoDiv = imgDiv.querySelector('.infor');
    const imageInfo = infoDiv.textContent;
    
    // Safely extract videoName from the .infor text (e.g. "L01_V001-34.5")
    const videoName = String(imageInfo || '').split('-')[0].trim();
    
    // Construct directory explicitly instead of relying on img.src (which could be a broken placeholder)
    const directory = `${window.MEDIA_BASE || window.location.origin}/media/frames/${videoName}/`;
    
    // Extract currentFrame from the img dataset or src
    let currentFrame = '0';
    if (img.dataset.realFrameId) {
      currentFrame = img.dataset.realFrameId;
    } else {
      const imgPath = img.src;
      const lastSlashIndex = imgPath.lastIndexOf('/');
      const originalFrameName = imgPath.substring(lastSlashIndex + 1).split('.')[0];
      if (originalFrameName.includes('_')) {
        currentFrame = originalFrameName.split('_')[1];
      }
    }

    framesContainer.dataset.currentFrame = currentFrame;
    framesContainer.dataset.directory = directory;
    framesContainer.dataset.videoName = videoName;

    // Load the canonical frame timeline from the backend.  The response is
    // built from the active visual sidecar and video metadata, so no legacy
    // static CSV server or guessed FPS is involved.
    await loadFrameListFromCSV(directory, imageInfo);
    
    await updateFrames(framesContainer, directory, currentFrame, imageInfo);
  }

  // Add event listener for keyboard navigation
  document.addEventListener('keydown', handleKeyPress);

  // Add event listener to close the video-frames div when Escape key is pressed
  document.addEventListener('keydown', escapeHandler);
  
  setupNavigationButtons();
}

function setupNavigationButtons() {
  const prevBtn = document.getElementById('prev-button');
  const nextBtn = document.getElementById('next-button');
  const showPreviewBtn = document.getElementById('show-preview-button');
  const hidePreviewBtn = document.getElementById('hide-preview-button');
  const closeBtn = document.querySelector('.close-button');
  const toggleViewBtn = document.getElementById('toggle-frame-view-button');

  // Clone and replace to remove any old event listeners
  if (prevBtn) {
    const newPrev = prevBtn.cloneNode(true);
    prevBtn.parentNode.replaceChild(newPrev, prevBtn);
    newPrev.addEventListener('click', () => navigateFrames(-1));
  }
  if (nextBtn) {
    const newNext = nextBtn.cloneNode(true);
    nextBtn.parentNode.replaceChild(newNext, nextBtn);
    newNext.addEventListener('click', () => navigateFrames(1));
  }
  if (showPreviewBtn) {
    const newShow = showPreviewBtn.cloneNode(true);
    showPreviewBtn.parentNode.replaceChild(newShow, showPreviewBtn);
    newShow.addEventListener('click', showCurrentFramePreview);
  }
  if (hidePreviewBtn) {
    const newHide = hidePreviewBtn.cloneNode(true);
    hidePreviewBtn.parentNode.replaceChild(newHide, hidePreviewBtn);
    newHide.addEventListener('click', hideCurrentFramePreview);
  }
  if (closeBtn) {
    const newClose = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);
    newClose.addEventListener('click', closeVideoFrames);
  }
  if (toggleViewBtn) {
    const newToggle = toggleViewBtn.cloneNode(true);
    toggleViewBtn.parentNode.replaceChild(newToggle, toggleViewBtn);
    newToggle.textContent = currentFrameStripView === 'boundaries' ? 'Chi tiết scene' : 'Chỉ biên scene';
    newToggle.addEventListener('click', toggleFrameStripView);
  }
}

async function loadFrameListFromCSV(directory, imageInfo, requestedView = 'boundaries') {
  const videoName = String(imageInfo || '').split('-')[0].trim()
    || directory.split('/').find(part => /^L\d+_V\d+$/.test(part));
  if (!videoName) {
    globalFrameList = [];
    globalSecondList = {};
    throw new Error('Không xác định được video_id của frame đang xem');
  }

  currentFrameStripVideo = videoName;
  currentFrameStripView = requestedView;
  const cacheKey = `${videoName}:${requestedView}`;
  const cached = videoFrameTimelineCache.get(cacheKey);
  if (cached) {
    globalFrameList = cached.frameIds.slice();
    globalSecondList = { ...cached.timestamps };
    return;
  }

  try {
    const response = await fetch(
      `${window.BACKEND_BASE}/api/videos/${encodeURIComponent(videoName)}/frames?view=${requestedView}`
    );
    const envelope = await response.json();
    if (!response.ok || !envelope.success || !Array.isArray(envelope.data)) {
      throw new Error(envelope.error || envelope.detail || `HTTP ${response.status}`);
    }

    globalFrameList = envelope.data
      .map(item => Number(item.frame_id))
      .filter(Number.isFinite);
    globalSecondList = envelope.data.reduce((timestamps, item) => {
      const frameId = Number(item.frame_id);
      const seconds = Number(item.timestamp_seconds);
      if (Number.isFinite(frameId) && Number.isFinite(seconds)) {
        timestamps[String(frameId)] = seconds;
      }
      return timestamps;
    }, {});
    if (globalFrameList.length === 0) {
      throw new Error(`Không có frame trong sidecar cho ${videoName}`);
    }
    videoFrameTimelineCache.set(cacheKey, {
      frameIds: globalFrameList.slice(),
      timestamps: { ...globalSecondList },
    });
  } catch (error) {
    globalFrameList = [];
    globalSecondList = {};
    console.error('Error loading video frame timeline:', error);
    if (typeof showToast === 'function') {
      showToast(`Không tải được dải frame của ${videoName}: ${error.message}`, 'error');
    }
  }
}

async function toggleFrameStripView() {
  const container = document.querySelector('.frames-container');
  if (!container || !currentFrameStripVideo) return;
  const nextView = currentFrameStripView === 'boundaries' ? 'all' : 'boundaries';
  const currentFrame = Number(container.dataset.currentFrame);
  const directory = container.dataset.directory;
  await loadFrameListFromCSV(directory, currentFrameStripVideo, nextView);
  await updateFrames(container, directory, currentFrame, currentFrameStripVideo);
  setupNavigationButtons();
}
  

// Create a container for a single frame
function createFrameContainer(src, frameNumber, isCurrent, frameInfo) {
  const frameContainer = document.createElement('div');
  frameContainer.className = 'frame-container';

  const frameElement = document.createElement('img');
  frameElement.src = src;
  frameElement.alt = 'Video Frame';
  frameElement.className = 'video-frame' + (isCurrent ? ' current-frame' : '');
  frameElement.dataset.frameNumber = frameNumber;

  const frameNameDiv = document.createElement('div');
  frameNameDiv.className = 'infor';

  frameNameDiv.textContent = `${frameInfo}`;

  const frameElements = document.querySelectorAll('.video-frame');
  frameElements.forEach((frame) => {
    frame.setAttribute('draggable', 'true');
    frame.addEventListener('dragstart', drag);
  });
  

  frameContainer.appendChild(frameElement);
  frameContainer.appendChild(frameNameDiv);

  frameContainer.addEventListener('click', () => {
    updateMainFrame(frameNumber, src.substring(0, src.lastIndexOf('/') + 1), frameInfo);
  });

  console.log(frameContainer);
  return frameContainer;
}


// Update the main frame and surrounding frames
async function updateMainFrame(newFrameNumber, directory, frameInfo) {
  const framesContainer = document.querySelector('.frames-container');
  framesContainer.dataset.currentFrame = newFrameNumber;
  framesContainer.dataset.directory = directory;

  // Remove current-frame-container class from all frame containers
  const allFrameContainers = framesContainer.querySelectorAll('.frame-container');
  allFrameContainers.forEach(container => {
    container.classList.remove('current-frame-container');
  });

  // Find the new current frame and update its classes
  const newCurrentFrame = framesContainer.querySelector(`[data-frame-number="${newFrameNumber}"]`);
  if (newCurrentFrame) {
    const newCurrentContainer = newCurrentFrame.closest('.frame-container');
    newCurrentContainer.classList.add('current-frame-container');
    newCurrentFrame.classList.add('current-frame');
  }

  const videoName = framesContainer.dataset.videoName;
  await updateFrames(framesContainer, directory, newFrameNumber, frameInfo, videoName);
}


// Update the frames in the container
async function updateFrames(container, directory, currentFrame, currentFrameInfo, overrideVideoName) {

  if (globalFrameList.length === 0) {
    console.error('Frame list is empty');
    return;
  }

  const currentIndex = globalFrameList.indexOf(parseInt(currentFrame));
  const nearestIndex = currentIndex !== -1 ? currentIndex : globalFrameList.reduce((prev, curr, idx) => 
    Math.abs(curr - currentFrame) < Math.abs(globalFrameList[prev] - currentFrame) ? idx : prev, 0);
  const resolvedCurrentFrame = globalFrameList[nearestIndex];
  container.dataset.currentFrame = String(resolvedCurrentFrame);

  const start = Math.max(0, nearestIndex - 20);
  const end = Math.min(globalFrameList.length, nearestIndex + 21);
  const framesToShow = globalFrameList.slice(start, end);

  const videoName = overrideVideoName || container.dataset.videoName;
  await updateFramesSmooth(container, directory, resolvedCurrentFrame, framesToShow, videoName);
}

async function updateFramesSmooth(container, directory, currentFrame, framesToShow, videoName) {
  const fragment = document.createDocumentFragment();

  for (let frameNumber of framesToShow) {
    const frameContainer = document.createElement('div');
    frameContainer.className = 'frame-container';
    if (frameNumber.toString() === currentFrame.toString()) {
      frameContainer.classList.add('current-frame-container');
    }
    frameContainer.innerHTML = `
      <img class="video-frame ${frameNumber.toString() === currentFrame.toString() ? 'current-frame' : ''}" data-frame-number="${frameNumber}" alt="Video Frame">
      <div class="infor"></div>
    `;
    fragment.appendChild(frameContainer);
  }

  container.innerHTML = '';
  container.appendChild(fragment);

  const updatePromises = Array.from(container.children).map((frameContainer, index) => {
    const frameNumber = framesToShow[index].toString();
    
    return updateFrameContainer(frameContainer, frameNumber, directory, currentFrame.toString() === frameNumber, videoName);
  });

  await Promise.all(updatePromises);

  const currentFrameElement = container.querySelector('.current-frame');
  if (currentFrameElement) {
    currentFrameElement.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
  }
}


async function updateFrameContainer(frameContainer, frameNumber, directory, isCurrent, providedVideoName) {
  const frameElement = frameContainer.querySelector('img');
  const frameNameDiv = frameContainer.querySelector('.infor');

  // Adjust this part based on your naming convention
  const framePath = `${directory}f_${String(frameNumber).padStart(8, '0')}.jpg`;

  frameElement.src = framePath;
  frameElement.className = 'video-frame' + (isCurrent ? ' current-frame' : '');
  frameElement.dataset.frameNumber = frameNumber;
  // console.log(globalSecondList)
  
  const seconds_json = globalSecondList[`${frameNumber}`];
  const videoName = providedVideoName || (directory.split('/').find(part => part.startsWith('L') && part.includes('V')));
  const frameInfo = `${videoName}-${seconds_json !== undefined ? seconds_json : '?'}`;
  frameNameDiv.textContent = frameInfo;

  frameContainer.className = 'frame-container' + (isCurrent ? ' current-frame-container' : '');

  frameContainer.addEventListener('click', () => {
    updateMainFrame(frameNumber, directory, frameInfo);
  });

  frameElement.setAttribute('draggable', 'true');
  frameElement.addEventListener('dragstart', drag);
  frameContainer.addEventListener('mousedown', handleMiddleClick);
  frameContainer.addEventListener('contextmenu', handleRightClick);

  await new Promise((resolve) => {
    if (frameElement.complete) {
      resolve();
    } else {
      frameElement.onload = resolve;
      frameElement.onerror = resolve;
    }
  });
}



// Navigate between frames
function navigateFrames(direction) {
  const framesContainer = document.querySelector('.frames-container');
  const currentFrame = parseInt(framesContainer.dataset.currentFrame);
  const directory = framesContainer.dataset.directory;
  
  const currentIndex = globalFrameList.indexOf(currentFrame);
  
  if (currentIndex === -1) {
    console.error("Current frame not found in global frame list");
    return;
  }

  const newIndex = currentIndex + direction;
  if (newIndex < 0 || newIndex >= globalFrameList.length) {
    console.log("Reached the end of frame list");
    return;
  }

  const newFrame = globalFrameList[newIndex];
  framesContainer.dataset.currentFrame = newFrame;

  const videoName = framesContainer.querySelector('.infor').textContent.split('-')[0];
  const timestampSeconds = globalSecondList[String(newFrame)];
  const frameInfo = `${videoName}-${timestampSeconds}`;

  updateMainFrame(newFrame, directory, frameInfo);
  updateCurrentPreview();
}


// Create an image element for a video frame
function createFrameElement(src, className) {
  const frame = document.createElement('img');
  frame.src = src;
  frame.alt = 'Video Frame';
  frame.classList.add('video-frame', className);
  return frame;
}


// Update the source and class of each frame in the container
function updateSurroundingFrames(container, directory, currentFrame) {
  const frames = container.querySelectorAll('.video-frame');
  const data_batch= directory.split('/')[4]
  const videoname=directory.split('/')[6]
  frames.forEach((frame, index) => {
    const frameNumber = currentFrame - 10 + index;
    if (data_batch==='data-batch-1' || (videoname <"L18_V001" && videoname>="L12_V001")){
      frame.src = `${directory}${frameNumber.toString().padStart(4, '0')}.webp`;
      }
      else{
      frame.src = `${directory}${frameNumber.toString().padStart(3, '0')}.webp`;
      }  
    frame.dataset.frameNumber = frameNumber;
    frame.className = 'video-frame' + (frameNumber === currentFrame ? ' current-frame' : ' other-frame');
  });
}


// Handle keyboard navigation
function handleKeyPress(event) {
  const videoPlayer = document.getElementById('vid_details');
  const isVideoPlaying = videoPlayer && !videoPlayer.paused;
  const fullscreenImage = document.getElementById('fullscreen-image-container');
  
  if (fullscreenImage.style.display === 'flex') {
    return; // Exit early if fullscreen image is displayed
  }

  if (isVideoPlaying) {
    return; // Exit if video is playing
  }

  const isInputElement = event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT';

  if (isInputElement) {
    return; // Exit if user is typing in an input
  }

  switch(event.key) {
    case 'ArrowLeft':
      event.preventDefault();
      navigateFrames(-1);
      updateCurrentPreview();
      break;
    case 'ArrowRight':
      event.preventDefault();
      navigateFrames(1);
      updateCurrentPreview();
      break;
    case 'ArrowUp':
      event.preventDefault();
      showCurrentFramePreview();
      break;
    case 'ArrowDown':
      event.preventDefault();
      // exportCurrentFrame();
      hideCurrentFramePreview();
      break;
    case '=':
      event.preventDefault();
      exportCurrentFrame();
      break;
  }
}


// New function to export the current frame
function exportCurrentFrame() {
  const currentFrameContainer = document.querySelector('.current-frame-container');
  if (currentFrameContainer) {
    const imgElement = currentFrameContainer.querySelector('img');
    const inforElement = currentFrameContainer.querySelector('.infor');
    
    if (imgElement && inforElement) {
      const frameId = inforElement.textContent.split('-')[1];
      const imageSrc = imgElement.src;
      const frameInfo = inforElement.textContent;
      
      addImageToExportArea(frameId, imageSrc, frameInfo);
    }
  }
}


// Close the video frames and reset UI
function closeVideoFrames() {
  const divVideoFrames = document.getElementById('video-frames');
  const leftPanel = document.querySelector('.left-panel');
  const rightPanel = document.querySelector('.right-panel');
  
  divVideoFrames.style.display = 'none';
  document.body.classList.remove('frame-strip-open');
  leftPanel.style.height = '';
  rightPanel.style.height = '';
  
  // Remove the event listener for keyboard navigation
  document.removeEventListener('keydown', handleKeyPress);
  document.removeEventListener('keydown', escapeHandler);
}

const escapeHandler = (event) => {
  if (event.key === 'Escape') {
    closeVideoFrames();
  }
};


//---------------------------------------------------------------------------------------------//
// Play video when right-click


function handleRightClick(event) {
  if (event.button === 2) { // Right mouse button
    event.preventDefault();
    const frameNumber = event.currentTarget.querySelector('.video-frame').dataset.frameNumber;
    const videoName = event.currentTarget.querySelector('.infor').textContent.split('-')[0];
    playVideoFromFrame(videoName, frameNumber);
  }
}



// Update playVideoFromFrame to be more consistent with showVideo
async function playVideoFromFrame(videoName, frameNumber) {
  console.log("videoName: " + videoName);
  console.log("frameNumber: " + frameNumber);
  const detailsDiv = document.getElementById('Details');
  const videoElement = document.getElementById('vid_details');
  let player = null;

  detailsDiv.style.display = 'block';

  const videoSrc = await getVideo(videoName);

  console.log("videoSrc: " + videoSrc);

  if (!videoElement.playerInstance) {
      videoElement.playerInstance = new VideoPlayer('vid_details', videoSrc);
      player = videoElement.playerInstance;
  } else {
      player = videoElement.playerInstance;
      player.videoSrc = videoSrc;
      player.initPlayer();
  }

  // Convert frame number to seconds
  // This conversion should match how frames are handled in your system
  // You might need to adjust this calculation based on your video's actual frame rate

  const timeInSeconds = globalSecondList[`${frameNumber}`]; // Assuming 25 fps

  player.video.currentTime = timeInSeconds;
  player.play();

  console.log("currentTime 2: " + timeInSeconds);

  // Ensure frame navigation still works
  const divVideoFrames = document.getElementById('video-frames');
  if (divVideoFrames.style.display === 'flex') {
      setupNavigationButtons();
      document.addEventListener('keydown', handleKeyPress);
  }
}


