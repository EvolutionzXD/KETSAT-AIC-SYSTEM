// Direct video opener. Reuses the same viewer and frame-extraction path as
// search-result clicks, so exported frame IDs have one implementation.
document.addEventListener('DOMContentLoaded', () => {
  const panel = document.getElementById('video-service-panel');
  const tab = document.getElementById('video-service-tab');
  const videoInput = document.getElementById('video-service-id');
  const timeInput = document.getElementById('video-service-time');
  const openButton = document.getElementById('video-service-open');
  const errorBox = document.getElementById('video-service-error');
  const searchCard = document.querySelector('.search-card');
  const buttonCard = document.querySelector('.button-card');
  const taskButtons = document.querySelectorAll('.task-name-main .task-button:not(#video-service-tab)');

  if (!panel || !tab || !videoInput || !openButton) return;

  function setServiceVisible(visible) {
    panel.hidden = !visible;
    tab.classList.toggle('active', visible);
    if (searchCard) searchCard.style.display = visible ? 'none' : '';
    if (buttonCard) buttonCard.style.display = visible ? 'none' : '';
    if (visible) {
      taskButtons.forEach(button => button.classList.remove('active'));
      requestAnimationFrame(() => videoInput.focus());
    }
  }

  function normalizeVideoId(value) {
    return String(value || '')
      .trim()
      .replace(/\.mp4$/i, '')
      .toUpperCase();
  }

  async function openRequestedVideo() {
    const videoId = normalizeVideoId(videoInput.value);
    const initialTime = Math.max(0, Number(timeInput?.value || 0));
    errorBox.textContent = '';

    if (!/^L\d+_V\d+$/.test(videoId)) {
      errorBox.textContent = 'Video ID không hợp lệ. Ví dụ đúng: L21_V001';
      videoInput.focus();
      return;
    }

    videoInput.value = videoId;
    openButton.disabled = true;
    openButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang kiểm tra...';
    try {
      const videoUrl = `${window.MEDIA_BASE}/media/videos/${encodeURIComponent(videoId)}.mp4`;
      const response = await fetch(videoUrl, { method: 'HEAD', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (typeof window.openVideoById !== 'function') throw new Error('Video viewer chưa sẵn sàng');
      await window.openVideoById(videoId, initialTime, videoUrl);
      localStorage.setItem('video-service-last-id', videoId);
    } catch (error) {
      console.error('Direct video open failed:', error);
      errorBox.textContent = `Không mở được ${videoId}. Hãy kiểm tra lại Video ID.`;
    } finally {
      openButton.disabled = false;
      openButton.innerHTML = '<i class="fas fa-play-circle"></i> Mở video';
    }
  }

  tab.addEventListener('click', () => setServiceVisible(panel.hidden));
  taskButtons.forEach(button => button.addEventListener('click', () => setServiceVisible(false)));
  openButton.addEventListener('click', openRequestedVideo);
  videoInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      openRequestedVideo();
    }
  });

  videoInput.value = localStorage.getItem('video-service-last-id') || '';
});
