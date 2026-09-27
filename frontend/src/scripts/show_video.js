//------------------------ Show video ------------------------//


// VideoPlayer class to handle video playback.
//
// Plays via HLS (GET /api/videos/{video_id}/hls/playlist.m3u8 — see
// src/media/hls_service.py, remuxes the source mp4 into segments on first
// request and caches them) using Hls.js in every browser without native
// HLS support, or the browser's native <video> HLS playback in Safari. If
// HLS packaging isn't available (hls_cache_dir unset server-side, or a
// packaging failure) this falls back to the raw single-file mp4 route
// (GET /api/videos/{video_id}, Range-request support) so playback still
// works either way.
class VideoPlayer {
    constructor(videoElementId, videoSrc, fallbackSrc) {
        this.video = document.getElementById(videoElementId);
        this.videoSrc = videoSrc;
        this.fallbackSrc = fallbackSrc;
        this.hls = null;
        this._usingFallback = false;

        this.initPlayer();

        this.initialTime = 0;
        this.addCustomControls();
    }

    initPlayer() {
        this._teardownHls();
        this._usingFallback = false;

        const isHls = typeof this.videoSrc === 'string' && this.videoSrc.includes('.m3u8');
        if (isHls && window.Hls && window.Hls.isSupported()) {
            this.hls = new window.Hls();
            this.hls.on(window.Hls.Events.ERROR, (_event, data) => {
                const isNetworkError = data.type === window.Hls.ErrorTypes.NETWORK_ERROR;
                if (data.fatal || isNetworkError) {
                    console.warn('HLS playback failed, falling back to mp4:', data);
                    this._teardownHls();
                    if (!this._usingFallback) {
                        this._usingFallback = true;
                        this.video.src = this.fallbackSrc;
                        this.video.currentTime = this.initialTime || 0;
                        this.video.play().catch(e => console.error('Fallback play failed:', e));
                    }
                }
            });
            this.hls.loadSource(this.videoSrc);
            this.hls.attachMedia(this.video);
        } else if (isHls && this.video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari: native HLS, no Hls.js needed.
            this.video.src = this.videoSrc;
        } else {
            this.video.src = this.fallbackSrc;
        }

        this.addEventListeners();
    }

    _teardownHls() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    }

    // Add event listeners to handle video playback events
    addEventListeners() {
        this.video.addEventListener('loadedmetadata', () => this.onLoadedMetadata());
        this.video.addEventListener('error', (e) => this.onError(e));
        this.video.addEventListener('waiting', () => this.onWaiting());
        this.video.addEventListener('canplay', () => this.onCanPlay());
        this.video.addEventListener('click', () => this.togglePlayPause());
    }
  
    onLoadedMetadata() {
        // console.log('Video metadata loaded');
    }
  
    onError(e) {
        if (this.fallbackSrc && !this._usingFallback) {
            this._usingFallback = true;
            this._teardownHls();
            this.video.src = this.fallbackSrc;
            this.video.load();
        }
    }
  
    onWaiting() {
        // console.log('Video is buffering');
    }
  
    onCanPlay() {
        // console.log('Video can play');
    }

    togglePlayPause() {
        // console.log('Video pause');
    }
  
    play() {
        this.video.play().catch(e => console.error('Play failed:', e));
    }
  
    pause() {
        this.video.pause();
    }
  
    seek(time) {
        if (isNaN(time)) return;
        this.video.currentTime = time;
    }
  
    // Clean up resources and remove event listeners
    destroy() {
        this._teardownHls();
        this.video.removeEventListener('loadedmetadata', this.onLoadedMetadata);
        this.video.removeEventListener('error', this.onError);
        this.video.removeEventListener('waiting', this.onWaiting);
        this.video.removeEventListener('canplay', this.onCanPlay);
        this.video.removeEventListener('click', this.togglePlayPause);
    }
    
    //----------------------------------
    addCustomControls() {
        document.getElementById('rewindBtn').addEventListener('click', () => this.skip(-10));
        document.getElementById('forwardBtn').addEventListener('click', () => this.skip(10));
        document.getElementById('initialTimeBtn').addEventListener('click', () => this.goToInitialTime());
        document.getElementById('playbackSpeed').addEventListener('change', (e) => {
            this.video.playbackRate = parseFloat(e.target.value);
        });
    }
    
    skip(seconds) {
        this.video.currentTime += seconds;
    }
    
    goToInitialTime() {
        this.video.currentTime = this.initialTime;
    }
  }


// Generate the raw single-file mp4 URL for a video_id (Range-request
// fallback — see VideoPlayer.initPlayer above).
function getVideo(videoId) {
    return `${window.BACKEND_BASE}/api/videos/${videoId}`;
}

// Warm the first bytes of the highest-ranked distinct videos without delaying
// result rendering. This primes the browser/Nginx/OS caches while keeping NFS
// pressure bounded: at most two Range requests run concurrently.
const videoPrefetchState = {
    controller: null,
    warmed: new Set(),
};

window.prefetchResultVideos = function(results, limit = 20) {
    const rows = Array.isArray(results) ? results : [];
    const videoIds = [];
    const seen = new Set();
    for (const row of rows) {
        const videoId = String(row?.video_id || '').trim();
        if (!/^L\d+_V\d+$/.test(videoId) || seen.has(videoId)) continue;
        seen.add(videoId);
        videoIds.push(videoId);
        if (videoIds.length >= limit) break;
    }

    if (videoPrefetchState.controller) videoPrefetchState.controller.abort();
    const controller = new AbortController();
    videoPrefetchState.controller = controller;
    const queue = videoIds.filter(videoId => !videoPrefetchState.warmed.has(videoId));

    const worker = async () => {
        while (queue.length && !controller.signal.aborted) {
            const videoId = queue.shift();
            try {
                const response = await fetch(getVideo(videoId), {
                    headers: { Range: 'bytes=0-2097151' },
                    cache: 'force-cache',
                    signal: controller.signal,
                    priority: 'low',
                });
                if (response.ok || response.status === 206) {
                    await response.arrayBuffer();
                    videoPrefetchState.warmed.add(videoId);
                }
            } catch (error) {
                if (error?.name !== 'AbortError') {
                    console.debug(`[video-prefetch] ${videoId} skipped`, error);
                }
            }
        }
    };

    Promise.all([worker(), worker()]).catch(() => {});
};

function getLegacyVideo(videoId) {
    return `${window.BACKEND_BASE}/api/videos/${videoId}`;
}

// Generate the HLS playlist URL for a video_id.
function getVideoHls(videoId) {
    return `${window.BACKEND_BASE}/api/videos/${videoId}/hls/playlist.m3u8`;
}



// Open the shared video viewer from either a search result or Video Service.
window.openVideoById = async function(videoId, initialTime = 0, videoUrl = null) {
    const detailsDiv = document.getElementById('Details')
    const videoElement = document.getElementById('vid_details');
    let player = null;
    const safeInitialTime = Number.isFinite(Number(initialTime)) ? Math.max(0, Number(initialTime)) : 0;
    
    // Store globally for the frame calculator panel
    window.current_active_video_id = videoId;

    // Show the details div
    detailsDiv.style.display = 'block';

    // HLS is primary; Nginx-served MP4 Range is the fallback.
    const videoSrc = videoUrl || getVideoHls(videoId);
    const fallbackSrc = getVideo(videoId);

    // Initialize the VideoPlayer if it hasn't been already
    if (!videoElement.playerInstance) {
        videoElement.playerInstance = new VideoPlayer('vid_details', videoSrc, fallbackSrc);
        player = videoElement.playerInstance;
    } else {
        player = videoElement.playerInstance;
        player.videoSrc = videoSrc;
        player.fallbackSrc = fallbackSrc;
        player.initPlayer(); // Re-initialize the player with the new source
    }

    // Set the video current time and play the video
    player.video.currentTime = safeInitialTime;
    player.initialTime = safeInitialTime;  // Store the initial time
    player.play();

    // Ensure frame navigation still works
    const divVideoFrames = document.getElementById('video-frames');
    if (divVideoFrames.style.display === 'flex') {
        setupNavigationButtons();
        document.addEventListener('keydown', handleKeyPress);
    }
    
    // Fetch and display ASR for this video
    loadASRForVideo(videoId);
    loadSurroundingFrames(videoId, safeInitialTime);
};

async function loadSurroundingFrames(videoId, currentTime) {
    const gallery = document.getElementById('surrounding-frames-gallery');
    if (!gallery) return;
    
    gallery.innerHTML = '<div style="color:#aaa; font-size:12px; padding:10px;">Đang tải frame lân cận...</div>';
    
    try {
        const response = await fetch(`${window.BACKEND_BASE}/api/videos/${videoId}/frames`);
        if (!response.ok) throw new Error('Failed to fetch frames');
        const data = await response.json();
        const frames = data.frames || [];
        window.current_video_frames = frames;
        
        // Draw markers now that we have frames
        drawVideoMarkers();
        
        if (frames.length === 0) {
            gallery.innerHTML = '';
            return;
        }
        
        // Find the closest frame to currentTime
        let closestIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < frames.length; i++) {
            const diff = Math.abs(frames[i].timestamp_seconds - currentTime);
            if (diff < minDiff) {
                minDiff = diff;
                closestIdx = i;
            }
        }
        
        // Take +/- 5 frames
        const startIdx = Math.max(0, closestIdx - 5);
        const endIdx = Math.min(frames.length - 1, closestIdx + 5);
        const surroundingFrames = frames.slice(startIdx, endIdx + 1);
        
        gallery.innerHTML = '';
        surroundingFrames.forEach((f, idx) => {
            const isCenter = (startIdx + idx) === closestIdx;
            const img = document.createElement('img');
            img.src = `${window.BACKEND_BASE}/api/frames/${videoId}/${f.frame_id}`;
            img.style.height = '60px';
            img.style.cursor = 'pointer';
            img.style.borderRadius = '4px';
            img.style.border = isCenter ? '2px solid #8b6bff' : '2px solid transparent';
            img.title = `Frame: ${f.frame_id} (${f.timestamp_seconds.toFixed(2)}s)`;
            
            img.addEventListener('click', () => {
                const videoElement = document.getElementById('vid_details');
                if (videoElement && videoElement.playerInstance) {
                    videoElement.playerInstance.video.currentTime = f.timestamp_seconds;
                }
                // Update borders
                Array.from(gallery.children).forEach(child => {
                    child.style.border = '2px solid transparent';
                });
                img.style.border = '2px solid #8b6bff';
            });
            
            gallery.appendChild(img);
        });
        
        } catch (e) {
        console.error("Error loading surrounding frames:", e);
        gallery.innerHTML = '';
    }
}

// Draw timeline markers
function drawVideoMarkers() {
    const timeline = document.getElementById('video-timeline-markers');
    const video = document.getElementById('vid_details');
    if (!timeline || !video || !window.current_active_video_id || !window.current_video_frames) return;
    
    // Clear existing markers
    timeline.innerHTML = '';
    
    // Wait for video duration
    if (!video.duration || isNaN(video.duration)) {
        // Retry when metadata is loaded
        video.addEventListener('loadedmetadata', drawVideoMarkers, { once: true });
        return;
    }
    
    const duration = video.duration;
    const frames = window.current_video_frames;
    const marks = window.marked_frames_state || { "incorrect": [], "caution": [] };
    const videoId = window.current_active_video_id;
    
    const allMarks = [
        ...marks.incorrect.map(id => ({ id, color: '#ff4d4d' })), // Red
        ...marks.caution.map(id => ({ id, color: '#ffcc00' }))    // Yellow
    ];
    
    allMarks.forEach(mark => {
        // Check if mark belongs to current video
        if (!mark.id.startsWith(videoId)) return;
        
        // Find timestamp for this frame_id
        const frame = frames.find(f => f.frame_id === mark.id.split('/')[1]);
        if (!frame) return;
        
        const percent = (frame.timestamp_seconds / duration) * 100;
        
        const dot = document.createElement('div');
        dot.style.position = 'absolute';
        dot.style.left = `${percent}%`;
        dot.style.top = '0';
        dot.style.width = '6px';
        dot.style.height = '100%';
        dot.style.background = mark.color;
        dot.style.transform = 'translateX(-50%)';
        dot.style.borderRadius = '3px';
        dot.style.boxShadow = '0 0 4px rgba(0,0,0,0.5)';
        dot.title = `Marked: ${mark.id}`;
        
        timeline.appendChild(dot);
    });
}

// Listen to marking updates from WebSocket
window.addEventListener('markersUpdated', drawVideoMarkers);

// Allow clicking timeline to seek
document.getElementById('video-timeline-markers')?.addEventListener('click', (e) => {
    const timeline = e.currentTarget;
    const rect = timeline.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const video = document.getElementById('vid_details');
    if (video && video.duration) {
        video.currentTime = percent * video.duration;
    }
});

// Show video details from a search-result thumbnail.
async function showVideo(img) {
    const result = data?.[img.id - 1];
    if (!result?.video_id) {
        if (typeof showToast === 'function') showToast('Không xác định được Video ID', 'error');
        return;
    }
    return window.openVideoById(
        result.video_id,
        result.timestamp_seconds,
        result.video_url || null
    );
}

// Global function to switch tabs in the video tools panel
window.switchVideoTool = function(tabId) {
    // Update tab buttons
    const tabs = document.querySelectorAll('.tool-tab-btn');
    tabs.forEach(tab => tab.classList.remove('active'));
    
    // The button that triggered it
    const activeBtn = Array.from(tabs).find(t => t.getAttribute('onclick').includes(`'${tabId}'`));
    if (activeBtn) activeBtn.classList.add('active');

    // Update tab content panels
    const contents = document.querySelectorAll('.tool-tab-content');
    contents.forEach(content => {
        content.classList.remove('active');
        content.style.display = 'none'; // Ensure inline style overrides if needed
    });
    
    const activeContent = document.getElementById(`tab-${tabId}`);
    if (activeContent) {
        activeContent.classList.add('active');
        activeContent.style.display = 'flex';
    }
}

async function loadASRForVideoLegacy(videoId) {
    const asrContainer = document.getElementById('asr-container');
    asrContainer.innerHTML = '<div class="asr-loading">Đang tải ASR...</div>';
    
    try {
        let response = await fetch(`${window.MEDIA_BASE}/media/asr/${videoId}.json`);
        if (!response.ok) {
            response = await fetch(`${window.BACKEND_BASE}/api/videos/${videoId}/asr`);
        }
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const asrSegments = await response.json();
        
        if (!asrSegments || asrSegments.length === 0) {
            asrContainer.innerHTML = '<div class="asr-loading">Không có dữ liệu ASR / Lời thoại cho video này.</div>';
            return;
        }

        asrContainer.innerHTML = '';
        asrSegments.forEach(segment => {
            const segDiv = document.createElement('div');
            segDiv.className = 'asr-segment';
            segDiv.title = `Click để tua đến ${segment.start.toFixed(1)}s`;
            
            // Format time HH:MM:SS
            const startTimeStr = new Date(segment.start * 1000).toISOString().substr(14, 5);
            
            segDiv.innerHTML = `
                <div class="asr-time">${startTimeStr}</div>
                <div class="asr-text">${segment.text}</div>
            `;
            
            segDiv.addEventListener('click', () => {
                const vidPlayer = document.getElementById('vid_details').playerInstance;
                if (vidPlayer) {
                    vidPlayer.seek(segment.start);
                }
                
                // Highlight active segment visually
                document.querySelectorAll('.asr-segment').forEach(s => s.classList.remove('active'));
                segDiv.classList.add('active');
            });
            
            asrContainer.appendChild(segDiv);
        });

    } catch (e) {
        console.error("Error loading ASR:", e);
        asrContainer.innerHTML = '<div class="asr-loading" style="color:var(--text-error);">Lỗi khi tải ASR.</div>';
    }
}
  

// The ASR sidecar uses start_seconds/end_seconds while older API responses
// use start/end. Keep the UI tolerant of both shapes and of wrapped payloads.
let asrLoadGeneration = 0;

function asrFiniteNumber(...values) {
    for (const value of values) {
        if (value === null || value === undefined || value === '' ||
            typeof value === 'boolean') continue;
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return number;
    }
    return null;
}

function asrTextValue(segment) {
    const record = segment && typeof segment.record === 'object'
        ? segment.record : null;
    const source = record ? { ...record, ...segment } : segment;
    if (!source || typeof source !== 'object') return '';
    for (const value of [source.text, source.transcript, source.asr,
                         source.caption, source.content]) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function normalizeASRSegments(payload) {
    let rawSegments = payload;
    if (!Array.isArray(rawSegments) && rawSegments &&
        typeof rawSegments === 'object') {
        for (const key of ['segments', 'data', 'results', 'asr']) {
            if (Array.isArray(rawSegments[key])) {
                rawSegments = rawSegments[key];
                break;
            }
        }
    }
    if (!Array.isArray(rawSegments)) return [];

    return rawSegments.map((rawSegment, sourceIndex) => {
        const segment = rawSegment && typeof rawSegment.record === 'object'
            ? { ...rawSegment.record, ...rawSegment } : rawSegment;
        const start = asrFiniteNumber(
            segment?.start, segment?.start_seconds, segment?.start_time,
            segment?.begin, segment?.startTime
        );
        const end = asrFiniteNumber(
            segment?.end, segment?.end_seconds, segment?.end_time,
            segment?.stop, segment?.endTime, start
        );
        return {
            start,
            end: end === null ? start : Math.max(start ?? 0, end),
            text: asrTextValue(rawSegment),
            sourceIndex,
        };
    }).filter(segment => segment.start !== null && segment.text)
      .sort((left, right) => left.start - right.start);
}

function formatASRTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const two = value => String(value).padStart(2, '0');
    return hours > 0
        ? `${two(hours)}:${two(minutes)}:${two(secs)}`
        : `${two(minutes)}:${two(secs)}`;
}

async function fetchASRJson(url) {
    if (!url) return null;
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) return null;
        return await response.json();
    } catch (_error) {
        return null;
    }
}

async function loadASRForVideo(videoId) {
    const asrContainer = document.getElementById('asr-container');
    if (!asrContainer) return;

    const generation = ++asrLoadGeneration;
    asrContainer.innerHTML = '<div class="asr-loading">Đang tải ASR...</div>';

    try {
        const encodedVideoId = encodeURIComponent(videoId);
        const mediaBase = window.MEDIA_BASE || window.location.origin;
        const backendBase = window.BACKEND_BASE || window.location.origin;
        let payload = await fetchASRJson(
            `${mediaBase}/media/asr/${encodedVideoId}.json`
        );
        if (payload === null) {
            payload = await fetchASRJson(
                `${backendBase}/api/videos/${encodedVideoId}/asr`
            );
        }
        if (generation !== asrLoadGeneration) return;

        const asrSegments = normalizeASRSegments(payload);
        if (asrSegments.length === 0) {
            asrContainer.innerHTML =
                '<div class="asr-loading">Không có dữ liệu ASR / Lời thoại cho video này.</div>';
            return;
        }

        asrContainer.replaceChildren();
        asrSegments.forEach(segment => {
            const segDiv = document.createElement('div');
            segDiv.className = 'asr-segment';
            segDiv.dataset.startSeconds = String(segment.start);
            segDiv.title = `Click để tua đến ${segment.start.toFixed(1)}s`;

            const timeDiv = document.createElement('div');
            timeDiv.className = 'asr-time';
            timeDiv.textContent = formatASRTime(segment.start);
            const textDiv = document.createElement('div');
            textDiv.className = 'asr-text';
            textDiv.textContent = segment.text;
            segDiv.append(timeDiv, textDiv);

            segDiv.addEventListener('click', () => {
                const videoElement = document.getElementById('vid_details');
                const vidPlayer = videoElement?.playerInstance;
                if (vidPlayer) {
                    vidPlayer.seek(segment.start);
                } else if (videoElement) {
                    videoElement.currentTime = segment.start;
                }

                document.querySelectorAll('.asr-segment')
                    .forEach(item => item.classList.remove('active'));
                segDiv.classList.add('active');
            });

            asrContainer.appendChild(segDiv);
        });
    } catch (error) {
        if (generation !== asrLoadGeneration) return;
        console.error('Error loading ASR:', error);
        asrContainer.innerHTML =
            '<div class="asr-loading" style="color:var(--text-error);">Lỗi khi tải ASR.</div>';
    }
}

// Close video details when Escape key is pressed
document.addEventListener("keydown", event => {
    if (event.key === 'Escape') {
        event.preventDefault();
        const detailsDiv = document.getElementById('Details');
        if (detailsDiv.style.display === 'block') {
            detailsDiv.style.display = 'none';
            document.getElementById('vid_details')?.pause(); // Pause video if open
        }
    }
});

// Close modal on click of close button or outside of modal
const modal = document.getElementById("Details");
const video = document.getElementById("vid_details");

document.getElementsByClassName("close")[0]?.addEventListener("click", () => {
    modal.style.display = "none";
    video.pause();
});

window.addEventListener("click", function(event){
    if (event.target == modal) {
        modal.style.display = "none";
        video.pause();
    }
});

// Move video
const draggableBar = document.querySelector('.draggable-bar');
const detailsBg = document.querySelector('.details_bg');
const detailsContainer = document.querySelector('#Details');

let isDragging = false;
let startX, startY, startLeft, startTop;

draggableBar.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = detailsBg.offsetLeft;
    startTop = detailsBg.offsetTop;
    e.preventDefault();
});

document.addEventListener('mouseup', () => {
    isDragging = false;
});

document.addEventListener('mousemove', (e) => {
    if (isDragging) {
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        // Lấy kích thước của màn hình và vị trí của container cha
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        
        let parentX = 0;
        let parentY = 0;
        if (detailsBg.offsetParent) {
            const parentRect = detailsBg.offsetParent.getBoundingClientRect();
            parentX = parentRect.left;
            parentY = parentRect.top;
        }

        // Giới hạn chiều ngang: Ít nhất 100px phải nằm trong màn hình
        const minLeft = -parentX - detailsBg.offsetWidth + 100;
        const maxLeft = screenWidth - parentX - 100;
        let newLeft = startLeft + deltaX;
        newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));

        // Giới hạn chiều dọc: Ít nhất 100px phải nằm trong màn hình
        const minTop = -parentY - detailsBg.offsetHeight + 100;
        const maxTop = screenHeight - parentY - 100;
        let newTop = startTop + deltaY;
        newTop = Math.max(minTop, Math.min(newTop, maxTop));

        // IN RA CONSOLE ĐỂ DEBUG
        console.log(`[DRAG DEBUG] parentX: ${parentX}, parentY: ${parentY}`);
        console.log(`[DRAG DEBUG] screenWidth: ${screenWidth}, screenHeight: ${screenHeight}`);
        console.log(`[DRAG DEBUG] detailsBg.offsetWidth: ${detailsBg.offsetWidth}`);
        console.log(`[DRAG DEBUG] X: minLeft=${minLeft}, maxLeft=${maxLeft} => newLeft=${newLeft}`);
        console.log(`[DRAG DEBUG] Y: minTop=${minTop}, maxTop=${maxTop} => newTop=${newTop}`);

        detailsBg.style.left = `${newLeft}px`;
        detailsBg.style.top = `${newTop}px`;
    }
});
