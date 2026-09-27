//------------------------ DRES submission (via backend proxy) ------------------------//

// ── FPS cache (frame index <-> milliseconds) ─────────────────────────────────
let _fpsCache = null;
async function ensureFpsCache() {
    if (_fpsCache) return;
    try {
        const r = await fetch(`${window.BACKEND_BASE}/api/video-fps`);
        if (r.ok) _fpsCache = await r.json();
    } catch {}
    if (!_fpsCache) _fpsCache = { default_fps: 25, overrides: {} };
}
function fpsFor(videoId) {
    const cache = _fpsCache || { default_fps: 25, overrides: {} };
    const overrides = cache.overrides || {};
    return Number(overrides[videoId] ?? cache.default_fps ?? 25);
}
function frameIdxToMs(frameIdx, videoId) {
    const fps = fpsFor(videoId);
    return Math.round((frameIdx * 1000) / fps);
}
// Calls backend/dres_proxy.py (POST /api/dres/login, GET /api/dres/evaluations,
// POST /api/dres/submit) instead of hitting DRES directly from the browser 
// the proxy relays to the real DRES v2 API (dres-dev/DRES doc/oas-client.json)
// server-side, avoiding the CORS/self-signed-cert issues a direct browser
// call would hit. Per the AIC guidelines doc: KIS answers are
// {mediaItemName, start, end} in milliseconds. QA answers are text rows in
// the official format: <video_name>, <frame_idx>, "<answer>".

function showTemporaryAlert(message) {
    const alertElement = document.createElement('div');
    alertElement.textContent = message;
    alertElement.style.position = 'fixed';
    alertElement.style.top = '20px';
    alertElement.style.left = '50%';
    alertElement.style.transform = 'translateX(-50%)';
    alertElement.style.backgroundColor = 'rgba(0,0,0,0.8)';
    alertElement.style.color = 'white';
    alertElement.style.padding = '10px 20px';
    alertElement.style.borderRadius = '5px';
    alertElement.style.zIndex = '1000';

    document.body.appendChild(alertElement);

    setTimeout(() => {
        alertElement.remove();
    }, 2500);
}

//------------------------------------------------------------------------------//
// Session state  sessionId/evaluationId/baseUrl/username persist across
// reloads (a competition run can span hours), but never the password.
// baseUrl is user-editable (not hardcoded) since the real competition-day
// DRES domain may differ from the practice default.

let dresSessionId = localStorage.getItem('dresSessionId') || null;
let dresEvaluationId = localStorage.getItem('dresEvaluationId') || null;
let dresBaseUrlValue = localStorage.getItem('dresBaseUrl') || window.DRES_BASE_URL || 'https://eventretrieval.one';
let dresUsernameValue = localStorage.getItem('dresUsername') || '';

function normalizeDresBaseUrl(value) {
    let url = String(value || '').trim();
    if (!url) return '';
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `http://${url}`;
    return url.replace(/\/+$/, '');
}

function dresBase() {
    return normalizeDresBaseUrl(dresBaseUrlValue);
}

function isDresLoggedIn() {
    return Boolean(dresSessionId && dresEvaluationId);
}

async function dresLogin(username, password) {
    const baseUrl = dresBase();
    if (!baseUrl) throw new Error('Vui lòng nhập Server URL của DRES.');
    dresBaseUrlValue = baseUrl;
    localStorage.setItem('dresBaseUrl', baseUrl);
    const response = await fetch(`${window.BACKEND_BASE}/api/dres/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, username: String(username || '').trim(), password: String(password || '') }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.detail || `Login failed (${response.status})`);
    }
    const payload = body && body.data && typeof body.data === 'object' ? body.data : body;
    const sessionId = payload?.sessionId ?? payload?.sessionID ?? payload?.session_id;
    if (sessionId === undefined || sessionId === null || String(sessionId).trim() === '') {
        throw new Error('DRES không trả về sessionId. Hãy kiểm tra Server URL hoặc tài khoản.');
    }
    dresSessionId = String(sessionId);
    localStorage.setItem('dresSessionId', dresSessionId);
    return body;
}

async function dresListEvaluations() {
    const url = `${window.BACKEND_BASE}/api/dres/evaluations?baseUrl=${encodeURIComponent(dresBase())}&session=${encodeURIComponent(dresSessionId)}`;
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.detail || `Failed to get evaluation list (${response.status})`);
    }
    const payload = body && body.data && typeof body.data === 'object' ? body.data : body;
    const list = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.evaluations) ? payload.evaluations
            : (Array.isArray(payload?.items) ? payload.items : null));
    if (!list) throw new Error('DRES trả về danh sách evaluation không hợp lệ.');
    return list
        .map((item) => ({
            ...item,
            id: item?.id ?? item?.evaluationId ?? item?.evaluation_id,
            name: item?.name ?? item?.title ?? String(item?.id ?? ''),
            status: item?.status ?? '',
        }))
        .filter((item) => item.id !== undefined && item.id !== null && String(item.id).trim() !== '');
}

function setActiveEvaluation(evaluationId) {
    dresEvaluationId = evaluationId;
    localStorage.setItem('dresEvaluationId', evaluationId);
    if (typeof broadcastDresSession === 'function') broadcastDresSession();
    updateDresLoginButton();
}

//------------------------------------------------------------------------------//
// Header button reflects login state persistently  it stays visible after
// the modal closes, unlike the modal's own transient success alert.

function updateDresLoginButton() {
    const button = document.getElementById('dres-login-button');
    if (!button) return;
    button.classList.toggle('dres-logged-in', isDresLoggedIn());
    if (isDresLoggedIn()) {
        button.title = `Đã đăng nhập DRES (${dresUsernameValue || 'không rõ tài khoản'}) — bấm để xem hoặc thay đổi`;
        button.innerHTML = `<i class="fas fa-check-circle" style="margin-right: 4px;"></i> DRES`;
    } else {
        button.title = 'Đăng nhập DRES';
        button.innerHTML = `<i class="fas fa-key" style="margin-right: 4px;"></i> DRES`;
    }
}

//------------------------------------------------------------------------------//
// Login modal  created once, reused. Styling lives in
// src/styles/dres_modal.css (matches the rest of the site's design tokens).
// Re-rendered every open so it always reflects the current logged-in state
// (baseUrl/username persist across reloads; password never does).

function renderDresModalBody(modal) {
    const statusHtml = isDresLoggedIn()
        ? `<div class="dres-status-line ok">✓ Đã đăng nhập với <b>${dresUsernameValue || '(?)'}</b> — evaluation: <b>${dresEvaluationId}</b></div>`
        : `<div class="dres-status-line neutral">Chưa đăng nhập.</div>`;

    modal.querySelector('.dres-modal-card').innerHTML = `
      <h3>Đăng nhập DRES</h3>
      ${statusHtml}
      <label class="dres-field-label">Server URL</label>
      <input type="text" id="dres-base-url" placeholder="https://eventretrieval.one" value="${dresBaseUrlValue}">
      <label class="dres-field-label">Tên đăng nhập</label>
      <input type="text" id="dres-username" placeholder="Tên đăng nhập" autocomplete="username" value="${dresUsernameValue}">
      <label class="dres-field-label">Mật khẩu</label>
      <input type="password" id="dres-password" placeholder="Mật khẩu" autocomplete="current-password">
      <div class="dres-modal-buttons">
        <button id="dres-login-submit">Đăng nhập</button>
        <button id="dres-login-cancel">Đóng</button>
      </div>
      <div id="dres-evaluation-picker" class="dres-evaluation-picker" style="display:none;">
        <p>Chọn evaluation:</p>
        <select id="dres-evaluation-select"></select>
        <div class="dres-modal-buttons">
          <button id="dres-evaluation-confirm">Xác nhận</button>
        </div>
      </div>
      <div class="dres-evaluation-picker">
        <p>Hoặc nhập Evaluation ID thủ công nếu danh sách tự động bị thiếu:</p>
        <input type="text" id="dres-evaluation-manual" placeholder="vd: 671f2a..." value="${dresEvaluationId || ''}">
        <div class="dres-modal-buttons">
          <button id="dres-evaluation-manual-confirm">Dùng ID này</button>
        </div>
      </div>
      ${isDresLoggedIn() ? `<div class="dres-modal-buttons"><button id="dres-logout" class="dres-logout-button">Đăng xuất</button></div>` : ''}
    `;

    const baseInput = modal.querySelector('#dres-base-url');
    const syncBaseUrl = () => {
        const normalized = normalizeDresBaseUrl(baseInput.value);
        if (normalized !== dresBaseUrlValue) {
            // A session issued by another DRES host cannot be reused safely.
            dresSessionId = null;
            dresEvaluationId = null;
            localStorage.removeItem('dresSessionId');
            localStorage.removeItem('dresEvaluationId');
            updateDresLoginButton();
        }
        dresBaseUrlValue = normalized;
        baseInput.value = normalized;
        localStorage.setItem('dresBaseUrl', normalized);
    };
    baseInput.addEventListener('change', syncBaseUrl);
    baseInput.addEventListener('blur', syncBaseUrl);

    modal.querySelector('#dres-login-cancel').addEventListener('click', () => {
        modal.style.display = 'none';
    });

    modal.querySelector('#dres-login-submit').addEventListener('click', async () => {
        const username = modal.querySelector('#dres-username').value.trim();
        const password = modal.querySelector('#dres-password').value;
        const loginButton = modal.querySelector('#dres-login-submit');
        if (!username || !password) {
            showTemporaryAlert('Vui lòng nhập đủ tên đăng nhập và mật khẩu DRES.');
            return;
        }
        syncBaseUrl();
        loginButton.disabled = true;
        loginButton.textContent = 'Đang đăng nhập...';
        try {
            await dresLogin(username, password);
            dresUsernameValue = username;
            localStorage.setItem('dresUsername', dresUsernameValue);
            updateDresLoginButton();
            const evaluations = await dresListEvaluations();
            if (evaluations.length === 0) {
                showTemporaryAlert('Tài khoản không có evaluation khả dụng. Bạn có thể nhập ID thủ công bên dưới.');
                return;
            }
            if (evaluations.length === 1) {
                setActiveEvaluation(evaluations[0].id);
                modal.style.display = 'none';
                showTemporaryAlert(`Đã đăng nhập DRES — evaluation: ${evaluations[0].name}`);
                return;
            }
            const picker = document.getElementById('dres-evaluation-picker');
            const select = document.getElementById('dres-evaluation-select');
            select.innerHTML = evaluations
                .map((run) => `<option value="${run.id}">${run.name} (${run.status})</option>`)
                .join('');
            picker.style.display = 'block';
        } catch (error) {
            showTemporaryAlert(error.message);
        } finally {
            loginButton.disabled = false;
            loginButton.textContent = 'Đăng nhập';
        }
    });

    modal.querySelector('#dres-evaluation-confirm').addEventListener('click', () => {
        const select = modal.querySelector('#dres-evaluation-select');
        setActiveEvaluation(select.value);
        modal.style.display = 'none';
        showTemporaryAlert('Đã chọn evaluation.');
    });

    modal.querySelector('#dres-evaluation-manual-confirm').addEventListener('click', () => {
        const manualId = modal.querySelector('#dres-evaluation-manual').value.trim();
        if (!manualId) {
            showTemporaryAlert('Vui lòng nhập Evaluation ID.');
            return;
        }
        if (!dresSessionId) {
            showTemporaryAlert('Bạn cần đăng nhập trước khi chọn evaluation.');
            return;
        }
        setActiveEvaluation(manualId);
        modal.style.display = 'none';
        showTemporaryAlert('Đã sử dụng Evaluation ID nhập thủ công.');
    });

    const logoutButton = modal.querySelector('#dres-logout');
    if (logoutButton) {
        logoutButton.addEventListener('click', () => {
            dresSessionId = null;
            dresEvaluationId = null;
            localStorage.removeItem('dresSessionId');
            localStorage.removeItem('dresEvaluationId');
            updateDresLoginButton();
            renderDresModalBody(modal);
            showTemporaryAlert('Đã đăng xuất DRES.');
        });
    }
}

function openDresLoginModal() {
    let modal = document.getElementById('dres-login-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'dres-login-modal';
        modal.innerHTML = `<div class="dres-modal-card"></div>`;
        document.body.appendChild(modal);
    }
    renderDresModalBody(modal);
    modal.style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', () => {
    const loginButton = document.getElementById('dres-login-button');
    if (loginButton) loginButton.addEventListener('click', openDresLoginModal);
    updateDresLoginButton();
});

//------------------------------------------------------------------------------//
// Submission

function getFirstResultForKIS() {
    return exportedImages[0];
}

function getFirstResultForVQA() {
    const result = exportedImages[0];
    if (!result) return [null, ''];

    // qaInputValue() is the single source of truth shared by the compact and
    // fullscreen QA editors. Do not read the first .vqa-input in the DOM:
    // both views render one, and that can submit a different/empty answer.
    if (typeof qaInputValue === 'function') {
        return [result, qaInputValue(result)];
    }
    const vqaInputEls = document.getElementsByClassName('vqa-input');
    return [result, vqaInputEls[0] ? vqaInputEls[0].value : ''];
}

const TASK_TO_DRES = { kis: 'KIS-T', vqa: 'Q&A', trake: 'TRAKE' };

function videoIdFor(item) {
    if (!item) return '';
    if (item.videoFramePart) return String(item.videoFramePart).split('/')[0];
    return String(item.frameInfo || '').replace(/-\d+$/, '');
}

// DRES QA/TRAKE text uses the original integer frame index. KIS alone uses a
// playback timestamp converted to milliseconds for the media answer.
function frameIdFor(item) {
    const part = String(item?.videoFramePart || '').split('/');
    const rawPartFrame = part.length === 2 ? String(part[1]).replace(/^f_/i, '') : '';
    const fromPart = rawPartFrame ? Number(rawPartFrame) : NaN;
    if (Number.isSafeInteger(fromPart) && fromPart >= 0) return fromPart;

    const displayMatch = String(item?.frameInfo || '').match(/-(\d+)$/);
    if (displayMatch) {
        const fromDisplay = Number(displayMatch[1]);
        if (Number.isSafeInteger(fromDisplay)) return fromDisplay;
    }

    const fallback = Number(item?.realFrameId ?? item?.frameId);
    return Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : null;
}

// KIS exported items may carry timestamp_seconds. QA does not use this
// helper: its DRES contract requires the original frame index.
function timestampMsFor(item, videoId) {
    const seconds = Number(item?.timestampSeconds);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }
    const frameId = frameIdFor(item);
    if (!Number.isSafeInteger(frameId)) return NaN;
    return frameIdxToMs(frameId, videoId);
}

function formatDresQaAnswer(item, answerText) {
    const videoId = videoIdFor(item);
    const timestampMs = timestampMsFor(item, videoId);
    const answer = String(answerText ?? '').trim();
    if (!videoId || !Number.isSafeInteger(timestampMs) || timestampMs < 0 || !answer) {
        showTemporaryAlert('Q&A cần Video ID, timestamp và câu trả lời.');
        return null;
    }
    // Competition Q&A contract: QA-<ANSWER>-<VIDEO_ID>-<TIMESTAMP_MS>.
    // Example: QA-ITALY-L21_V016-783500.
    return `QA-${answer}-${videoId}-${timestampMs}`;
}

function formatDresTrakeFrameAnswer(videoId, frameIds) {
    if (!videoId || !Array.isArray(frameIds) || !frameIds.length ||
        frameIds.some((frame) => !Number.isSafeInteger(frame) || frame < 0)) {
        showTemporaryAlert('TRAKE cần Video ID và các frame ID nguyên hợp lệ.');
        return null;
    }
    return `TR-${videoId}-${frameIds.join(',')}`;
}

function formatDresTrakeAnswer(items) {
    if (!Array.isArray(items) || !items.length) {
        showTemporaryAlert('Chưa có mốc thời gian TRAKE để nộp.');
        return null;
    }
    const videoId = videoIdFor(items[0]);
    if (!videoId || items.some((item) => videoIdFor(item) !== videoId)) {
        showTemporaryAlert('TRAKE chỉ được nộp các frame thuộc cùng một video.');
        return null;
    }
    const frameIds = items.map(frameIdFor);
    return formatDresTrakeFrameAnswer(videoId, frameIds);
}

async function submit_to_dres_v2() {
    if (!dresSessionId || !dresEvaluationId) {
        showTemporaryAlert('Bạn chưa đăng nhập DRES. Vui lòng đăng nhập rồi nộp lại.');
        openDresLoginModal();
        return;
    }

    const base = { baseUrl: dresBase(), session: dresSessionId, evaluationId: dresEvaluationId, task: TASK_TO_DRES[activeTask] };

    if (activeTask === 'kis') {
        await ensureFpsCache();
        const result = getFirstResultForKIS();
        if (!result) {
            showTemporaryAlert('Chưa có kết quả nào trong danh sách nộp.');
            return;
        }
        const videoId = videoIdFor(result);
        const startMs = timestampMsFor(result, videoId);
        await submitFrameInfo({ ...base, videoId, startMs });
    } else if (activeTask === 'vqa') {
        const [result, answerText] = getFirstResultForVQA();
        if (!result || !answerText) {
            showTemporaryAlert('Thiếu khung hình hoặc câu trả lời trước khi nộp Q&A.');
            return;
        }
        const formattedAnswer = formatDresQaAnswer(result, answerText);
        if (!formattedAnswer) return;
        // The proxy's Q&A branch forwards answer verbatim as {text: ...}.
        await submitFrameInfo({ ...base, task: 'Q&A', answer: formattedAnswer });
    } else if (activeTask === 'trake') {
        const formattedAnswer = formatDresTrakeAnswer(exportedImages);
        if (!formattedAnswer) return;
        // TRAKE's competition contract is also a text answer.  Use the
        // proxy's Q&A forwarding branch so the exact TR-... string reaches
        // DRES unchanged; this does not restart or alter the backend.
        await submitFrameInfo({ ...base, task: 'Q&A', answer: formattedAnswer });
    }
}

async function submitSingleImage_v2(index) {
    if (!dresSessionId || !dresEvaluationId) {
        showTemporaryAlert('Bạn chưa đăng nhập DRES. Vui lòng đăng nhập rồi nộp lại.');
        openDresLoginModal();
        return;
    }
    const item = exportedImages[index];
    if (!item) {
        showTemporaryAlert('Không tìm thấy frame.');
        return;
    }
    const base = { baseUrl: dresBase(), session: dresSessionId, evaluationId: dresEvaluationId, task: TASK_TO_DRES[activeTask] };

    if (activeTask === 'kis') {
        await ensureFpsCache();
        const videoId = videoIdFor(item);
        const startMs = timestampMsFor(item, videoId);
        await submitFrameInfo({ ...base, videoId, startMs });
    } else if (activeTask === 'vqa') {
        const answerText = typeof qaInputValue === 'function' ? qaInputValue(item) : '';
        if (!answerText) {
            showTemporaryAlert('Thiếu câu trả lời trước khi nộp Q&A.');
            return;
        }
        const formattedAnswer = formatDresQaAnswer(item, answerText);
        if (!formattedAnswer) return;
        await submitFrameInfo({ ...base, task: 'Q&A', answer: formattedAnswer });
    } else if (activeTask === 'trake') {
        showTemporaryAlert('TRAKE yêu cầu nộp toàn bộ chuỗi sự kiện. Vui lòng dùng nút Nộp bài chính.');
    }
}

let submissionInFlight = false;

async function submitFrameInfo(body) {
    if (submissionInFlight) {
        showTemporaryAlert('Bài đang được gửi, vui lòng chờ...');
        return;
    }
    submissionInFlight = true;
    const submitButtons = document.querySelectorAll('#submit-button, #submit-export-button, #trake-ws-submit');
    submitButtons.forEach((button) => { button.disabled = true; });
    try {
        const payload = { answerSets: [{ answers: [] }] };
        if (body.task === 'Q&A' || body.task === 'TRAKE') {
            payload.answerSets[0].answers.push({ text: body.answer });
        } else {
            payload.answerSets[0].answers.push({
                mediaItemName: body.videoId,
                start: body.startMs,
                end: body.startMs
            });
        }

        const submitUrl = `${body.baseUrl}/api/v2/submit/${body.evaluationId}?session=${body.session}`;
        
        const response = await fetch(submitUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            showTemporaryAlert(data.description || data.detail || `Lỗi khi nộp (${response.status})`);
            return;
        }

        const verdict = data.submission; // CORRECT | WRONG | INDETERMINATE | UNDECIDABLE
        if (verdict === 'CORRECT' || verdict === 'WRONG') {
            if (activeTask === 'kis' || activeTask === 'vqa') {
                exportedImages.shift();
            } else if (activeTask === 'trake') {
                exportedImages.splice(0, exportedImages.length);
            }
            if (typeof renderExportArea === 'function') renderExportArea();
            if (verdict === 'CORRECT') {
                showTemporaryAlert('✅ Chính xác!');
            } else {
                showTemporaryAlert('❌ Chưa chính xác.');
            }
        } else {
            showTemporaryAlert(`Đã nộp — trạng thái: ${verdict || 'đang chờ xét duyệt'}`);
        }
    } catch (error) {
        showTemporaryAlert(`Lỗi khi nộp: ${error.message}`);
    } finally {
        submissionInFlight = false;
        submitButtons.forEach((button) => { button.disabled = false; });
    }
}
