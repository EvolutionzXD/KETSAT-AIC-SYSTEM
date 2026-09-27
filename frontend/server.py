#!/usr/bin/env python3
"""Server cho aic_final_frontend (giống server.py của frontend-vanilla).

  * phục vụ index.html / app.js / style.css
  * /media/videos/<ID>.mp4 và /media/frames/<ID>/f_XXXXXXXX.jpg:
        lấy từ máy (thư mục data/batch1, data/batch2, …) trước — không có thì lấy từ backend
  * OCR / ASR / danh sách keyframe / FPS: đọc file gốc của backend chép vào data/meta/ trước —
        video nào không có trong file ở máy thì hỏi backend
  * chuyển tiếp /api/*, /health, /submission/* và WebSocket /ws/* tới backend
  * /dres/api/v2/* → chuyển tiếp tới server DRES của BTC (tránh CORS / chứng chỉ tự ký)

Chạy (backend ở server qua SSH tunnel):
    ssh -L 8602:localhost:8602 <user>@<server>        # cửa sổ 1, giữ mở
    python server.py                                   # cửa sổ 2 → http://localhost:8082

Tuỳ chọn:
    python server.py --backend http://127.0.0.1:8603 --port 8090
    python server.py --data E:\\AIC_data               # thêm thư mục dữ liệu (lặp lại được)
"""
import argparse
import difflib
import http.client
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_ROOT = ROOT / "data"
PROXY_PREFIXES = ("/api/", "/ws/", "/submission/")
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade", "server", "date"}
VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mov"}
IMG_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".png": "image/png"}
ID_RE = re.compile(r"^[A-Za-z]+\d+[_-]V\d+$", re.I)  # tên thư mục keyframe = Video ID, vd L21_V001, N051-V001

ap = argparse.ArgumentParser(description="AIC final frontend server")
ap.add_argument("port_pos", nargs="?", type=int, help=argparse.SUPPRESS)  # python server.py 8090
ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8082)))
ap.add_argument("--backend", default=os.environ.get("BACKEND_URL", "http://127.0.0.1:8602"),
                help="địa chỉ backend (mặc định http://127.0.0.1:8602 — đầu SSH tunnel)")
ap.add_argument("--timeout", type=float, default=600, help="giây chờ backend (search DeepSeek có thể lâu)")
ap.add_argument("--data", action="append", default=[], help="thư mục dữ liệu cục bộ thêm (video/keyframe)")
ARGS = ap.parse_args()
ARGS.port = ARGS.port_pos or ARGS.port

BACKEND = urllib.parse.urlsplit(ARGS.backend.rstrip("/"))
if BACKEND.scheme not in ("http", "https") or not BACKEND.hostname:
    sys.exit(f"--backend không hợp lệ: {ARGS.backend}")


def connect(url, timeout):
    """HTTP(S) connection tới url đã urlsplit (bỏ qua chứng chỉ tự ký)."""
    port = url.port or (443 if url.scheme == "https" else 80)
    if url.scheme == "https":
        return http.client.HTTPSConnection(url.hostname, port, timeout=timeout, context=ssl._create_unverified_context())
    return http.client.HTTPConnection(url.hostname, port, timeout=timeout)


# ── Dữ liệu cục bộ: video (.mp4/.mov/…) ở bất kỳ đâu; keyframe trong thư mục tên <VIDEO_ID> ──
# Thư mục được quét: data/ + --data + LOCAL_DATA_DIR + các thư mục trong data/video_dirs.txt
# (thêm / xoá ngay trên trang: ⚙️ Cài đặt → Thư mục video trên máy — ổ khác cũng được).
DIRS_FILE = DATA_ROOT / "video_dirs.txt"
FIXED_DIRS = [(DATA_ROOT, "mặc định"), *((Path(p), "--data") for p in ARGS.data),
              *([(Path(os.environ["LOCAL_DATA_DIR"]), "LOCAL_DATA_DIR")] if os.environ.get("LOCAL_DATA_DIR") else [])]
VIDEOS, FRAMES = {}, {}          # "N051-V001" -> file video / [thư mục keyframe]
VIDEO_KEYS, FRAME_KEYS = {}, {}  # ("N", 51, 1) -> "N051-V001": khớp ID dù "_" hay "-", thiếu số 0
VIDEO_KEY_RE = re.compile(r"([A-Z]+)0*(\d+)[\s_-]*V0*(\d+)")
SCAN = {"at": 0.0, "lock": threading.Lock(), "per": {}, "sig": None}


def clean_dir(p):
    """Đường dẫn người dùng dán: bỏ ngoặc kép ("Copy as path" của Windows), khoảng trắng, dấu \\ cuối."""
    p = str(p).strip().strip("\"'").strip()
    if re.fullmatch(r"[A-Za-z]:[\\/]?", p):  # gốc ổ đĩa: giữ "E:\\"
        return p[:2] + os.sep
    return p.rstrip("\\/") or p


def read_dirs_file():
    try:
        lines = DIRS_FILE.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return []
    return list(dict.fromkeys(clean_dir(x) for x in lines if x.strip() and not x.lstrip().startswith("#")))


def write_dirs_file(dirs):
    DIRS_FILE.parent.mkdir(parents=True, exist_ok=True)
    DIRS_FILE.write_text("# Thư mục chứa video / keyframe trên máy — mỗi dòng 1 thư mục (quét sâu 5 cấp).\n"
                         "# Sửa trên trang (⚙️ Cài đặt → Thư mục video trên máy) hoặc sửa file này rồi đợi ≤ 30 giây.\n"
                         + "".join(d + "\n" for d in dirs), encoding="utf-8")


def dirs_file_sig():
    try:
        st = DIRS_FILE.stat()
        return st.st_mtime_ns, st.st_size
    except OSError:
        return None


def dirs_file_changed():
    """video_dirs.txt vừa được sửa (tay hoặc qua trang) mà chưa quét lại."""
    return dirs_file_sig() != SCAN["sig"]


def data_dirs():
    return [*FIXED_DIRS, *((Path(d), "video_dirs.txt") for d in read_dirs_file())]


def video_key(s):
    m = VIDEO_KEY_RE.fullmatch(str(s).strip().upper())
    return (m.group(1), int(m.group(2)), int(m.group(3))) if m else None


def key_map(ids):
    keys = {}
    for sid in sorted(ids):
        k = video_key(sid)
        if k:
            keys.setdefault(k, sid)
    return keys


def scan(max_depth=5):
    global VIDEOS, FRAMES, VIDEO_KEYS, FRAME_KEYS
    vids, frames, per = {}, {}, {}

    def walk(d, depth, stat):
        try:
            entries = list(os.scandir(d))
        except OSError:
            return
        for e in entries:
            try:
                is_dir = e.is_dir(follow_symlinks=True)
            except OSError:
                continue
            if is_dir:
                if ID_RE.match(e.name):  # thư mục keyframe của 1 video: ghi nhận, không cần liệt kê hàng nghìn ảnh
                    frames.setdefault(e.name.upper(), []).append(Path(e.path))
                    stat["frame_dirs"] += 1
                elif depth < max_depth and not e.name.startswith(("$", ".")):  # bỏ $RECYCLE.BIN, thư mục ẩn
                    walk(e.path, depth + 1, stat)
            else:
                stem, ext = os.path.splitext(e.name)
                if ext.lower() in VIDEO_EXTS:
                    vids.setdefault(stem.upper(), Path(e.path))
                    stat["videos"] += 1

    sig = dirs_file_sig()
    for base, source in data_dirs():
        stat = {"path": str(base), "source": source, "exists": base.is_dir(), "videos": 0, "frame_dirs": 0}
        if stat["exists"]:
            walk(base, 0, stat)
        per[str(base)] = stat
    # thay cả bảng 1 lần — request đang chạy không thấy bảng rỗng giữa chừng
    VIDEOS, FRAMES, VIDEO_KEYS, FRAME_KEYS = vids, frames, key_map(vids), key_map(frames)
    SCAN["per"], SCAN["sig"] = per, sig
    SCAN["at"] = time.time()


def rescan_if_stale(wait=False, max_age=30):
    """File mới chép vào / thư mục mới thêm được thấy mà không cần khởi động lại.
    Quét lại khi lần quét trước cũ hơn max_age giây, hoặc video_dirs.txt vừa bị sửa.
    wait=False: quét nền để request đang chờ (vd ảnh keyframe) không bị treo.
    wait=True: quét xong mới trả lời (người dùng đang mở video) — có lượt quét khác đang chạy thì chờ nó."""
    def needed():
        return time.time() - SCAN["at"] > max_age or dirs_file_changed()
    if not needed():
        return
    if wait:
        if SCAN["lock"].acquire(timeout=60):
            try:
                if needed():  # lượt quét vừa chạy xong có thể đã cập nhật rồi
                    scan()
            finally:
                SCAN["lock"].release()
        return
    if not SCAN["lock"].acquire(blocking=False):
        return
    SCAN["at"] = time.time()

    def run():
        try:
            scan()
        finally:
            SCAN["lock"].release()
    if wait:
        run()
    else:
        threading.Thread(target=run, daemon=True).start()


def rescan_now():
    with SCAN["lock"]:
        scan()


def dirs_info():
    rows = []
    for base, source in data_dirs():
        info = SCAN["per"].get(str(base)) or {"path": str(base), "exists": base.is_dir(), "videos": 0, "frame_dirs": 0}
        rows.append({**info, "source": source, "removable": source == "video_dirs.txt"})
    return {"dirs": rows, "file": str(DIRS_FILE), "videos": len(VIDEOS), "frame_dirs": len(FRAMES)}


def _lookup(table, keys, vid):
    sid = str(vid).upper()
    if sid not in table:  # backend gọi N051_V001 mà file là N051-V001 (hoặc ngược lại) vẫn khớp
        sid = keys.get(video_key(sid)) or sid
    return table.get(sid)


def local_video(vid):
    if dirs_file_changed():  # vừa thêm / bỏ thư mục trong video_dirs.txt → quét lại trước khi tìm
        rescan_if_stale(wait=True)
    p = _lookup(VIDEOS, VIDEO_KEYS, vid)
    if p and p.is_file():
        return p
    rescan_if_stale()  # quét nền: video mới chép vào sẽ thấy ở lần mở sau
    return None


def local_frame(vid, frame):
    if dirs_file_changed():
        rescan_if_stale(wait=True)
    dirs = _lookup(FRAMES, FRAME_KEYS, vid)
    if not dirs:
        rescan_if_stale()
        return None
    for d in dirs:
        for name in (f"f_{frame:08d}.jpg", f"f_{frame:08d}.webp", f"{frame:05d}.jpg"):
            p = d / name
            if p.is_file():
                return p
    return None


def backend_has_video(vid):
    """True/False: backend có video này không. OSError nếu không kết nối được backend."""
    conn = connect(BACKEND, 6)
    try:
        conn.request("GET", f"{BACKEND.path}/api/videos/{urllib.parse.quote(vid)}",
                     headers={"Host": BACKEND.netloc, "Range": "bytes=0-0"})
        return conn.getresponse().status in (200, 206)  # không đọc thân — chỉ cần mã trạng thái
    finally:
        conn.close()


def find_video(q):
    """Tìm Video ID thật cho chuỗi người dùng gõ — ở máy trước, rồi backend.
    Chấp nhận "_" / "-" / dấu cách, thiếu số 0 đệm, có đuôi file: n51_v1, N051 V001, N051-V001.mov → N051-V001."""
    s = re.sub(r"\.(mp4|mov|mkv|webm|avi|m4v)$", "", str(q).strip(), flags=re.I).strip().upper()
    res = {"found": False, "query": q, "id": None, "source": None, "suggest": [], "backend_error": None}
    if not s or len(s) > 64 or not re.fullmatch(r"[A-Z0-9_ -]+", s):
        return res
    if dirs_file_changed():
        rescan_if_stale(wait=True)
    key = video_key(s)
    sid = s if s in VIDEOS else VIDEO_KEYS.get(key) if key else None
    if not sid:  # người dùng đang gõ ID để mở: quét lại (nếu lần trước cũ hơn 5 giây) trước khi báo không tìm thấy
        rescan_if_stale(wait=True, max_age=5)
        sid = s if s in VIDEOS else VIDEO_KEYS.get(key) if key else None
    if sid:
        return {**res, "found": True, "id": VIDEOS[sid].stem, "source": "local"}
    cands = [s.replace(" ", "_"), s.replace(" ", "-")]
    cands += [c.replace("-", "_") for c in cands] + [c.replace("_", "-") for c in cands]
    if key:
        a, n, v = key
        cands += [f"{a}{n:0{w}d}{sep}V{v:03d}" for w in (2, 3) for sep in ("_", "-")]
    for c in dict.fromkeys(cands):  # bỏ trùng, giữ thứ tự
        try:
            if backend_has_video(c):
                return {**res, "found": True, "id": c, "source": "server"}
        except OSError as e:
            res["backend_error"] = str(e)
            break
    # Gợi ý khi gõ sai: giống nhất trước; hoà điểm thì ưu tiên trùng nhiều ký tự đúng vị trí (N05l-V001 → N051-V001).
    norm = lambda x: re.sub(r"[\s_-]", "_", x)
    q = norm(s)

    def score(k):
        n = norm(k)
        return difflib.SequenceMatcher(None, q, n).ratio(), sum(a == b for a, b in zip(q, n))
    scored = [k for (ratio, _), k in sorted(((score(k), k) for k in VIDEOS), reverse=True)[:6] if ratio >= 0.75]
    # gõ nhầm chữ giống số sau phần chữ đầu: l/I → 1, O → 0 (N05l-V001, L21_V0O1) → gợi ý đó lên đầu
    head = re.match(r"[A-Z]*", s).group(0)
    lookalike = VIDEO_KEYS.get(video_key(head + s[len(head):].translate(str.maketrans("OIL", "011"))))
    res["suggest"] = [VIDEOS[k].stem for k in dict.fromkeys(([lookalike] if lookalike else []) + scored)][:3]
    return res


# ── OCR / ASR / keyframe / FPS ở máy: chép file GỐC của backend vào data/meta/ ──
# Đọc đúng định dạng aic_backend_RRF_exp đang dùng và trả kết quả giống hệt API của nó:
#   video_metadata*.json  {video_id: {fps, …}}                     → /api/video-fps (+ tính timestamp)
#   ocr*.json             {doc_id: {video_id, frame_id, text}}     → /api/videos/<ID>/ocr
#   segments.json, *asr*  [{video_id, start, end, text, …}]        → /api/videos/<ID>/asr
#   frame_ids*.json       ["L21_V001_123", …]                      → /api/videos/<ID>/frames?view=all
#   event_segments*.json  {"segments": {video_id: {frame: event}}} → /api/videos/<ID>/frames?view=boundaries
# Nhiều file cùng loại (vd batch1 + batch2) được gộp. Video không có trong file ở máy → hỏi backend.
META_DIR = DATA_ROOT / "meta"
META_KINDS = (  # (loại, tên hiển thị, nhận dạng theo tên file viết thường)
    ("fps", "FPS", lambda n: n.startswith("video_metadata")),
    ("ocr", "OCR", lambda n: "ocr" in n),
    ("asr", "ASR", lambda n: "asr" in n or n == "segments.json"),
    ("frames", "keyframe", lambda n: n.startswith("frame_ids")),
    ("kcp", "biên scene", lambda n: n.startswith("event_segments")),
)
DEFAULT_FPS = 25.0  # giống backend khi video không có FPS trong metadata


def meta_files():
    """{loại: [(tên, size, mtime), …]} và danh sách file .json không nhận ra."""
    found, unknown = {}, []
    try:
        entries = sorted(os.scandir(META_DIR), key=lambda e: e.name.lower())
    except OSError:
        return found, unknown
    for e in entries:
        n = e.name.lower()
        if not (e.is_file() and n.endswith(".json")):
            continue
        kind = next((k for k, _, match in META_KINDS if match(n)), None)
        if kind:
            st = e.stat()
            found.setdefault(kind, []).append((e.name, st.st_size, st.st_mtime))
        else:
            unknown.append(e.name)
    return found, unknown


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def load_meta_kind(kind, paths):
    """Đọc 1 loại (gộp nhiều file) → {video_id: dữ liệu của video đó}."""
    out = {}
    for p in paths:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if kind == "fps":
            if not isinstance(data, dict):
                raise ValueError("cần JSON object {video_id: {fps: …}}")
            out.update(data)
        elif kind == "ocr":  # giống get_video_ocr của backend
            if not isinstance(data, dict):
                raise ValueError("cần JSON object {doc_id: {video_id, frame_id, text}}")
            for doc_id, rec in data.items():
                if not isinstance(rec, dict):
                    continue
                vid = rec.get("video_id") or (doc_id.rsplit("_", 1)[0] if "_" in doc_id else doc_id)
                try:
                    frame = int(rec.get("frame_id", 0))
                except (TypeError, ValueError):
                    continue
                out.setdefault(str(vid).lower(), []).append((frame, str(doc_id), rec.get("text", "")))
            del data
        elif kind == "asr":  # giống get_video_asr của backend
            if isinstance(data, dict):
                data = next((data[k] for k in ("segments", "data", "results") if isinstance(data.get(k), list)), data)
            if not isinstance(data, list):
                raise ValueError("cần JSON list [{video_id, start, end, text}]")
            for s in data:
                if isinstance(s, dict) and s.get("video_id"):
                    out.setdefault(str(s["video_id"]), []).append(s)
        elif kind == "frames":  # giống get_video_frame_timeline(view="all")
            if not isinstance(data, list):
                raise ValueError('cần JSON list ["L21_V001_123", …]')
            for key in data:
                vid, sep, frame = str(key).rpartition("_")
                try:
                    if sep:
                        out.setdefault(vid, []).append(int(frame))
                except ValueError:
                    continue
            del data
        elif kind == "kcp":  # giống KCPEventIndex.from_json
            seg = data.get("segments") if isinstance(data, dict) else None
            if not isinstance(seg, dict):
                raise ValueError("cần khoá 'segments' {video_id: {frame: event_id}}")
            for vid, fmap in seg.items():
                out.setdefault(str(vid), {}).update({int(fr): str(ev) for fr, ev in fmap.items()})
            del data, seg
    if kind == "ocr":
        for rows in out.values():
            rows.sort(key=lambda r: r[0])
    elif kind == "asr":
        for rows in out.values():
            rows.sort(key=lambda s: _num(s.get("start", 0)))
    return out


class Meta:
    def __init__(self):
        self.data, self.info, self.sig, self.unknown = {}, {}, {}, []
        self.lock, self.checked = threading.Lock(), 0.0

    def load(self, verbose=False):
        files, self.unknown = meta_files()
        data, info, sig = {}, {}, {}
        for kind, label, _ in META_KINDS:
            if kind not in files:
                continue
            sig[kind] = tuple(files[kind])
            if self.sig.get(kind) == sig[kind] and kind in self.info:  # file không đổi → giữ bản đã đọc
                info[kind] = self.info[kind]
                if kind in self.data:
                    data[kind] = self.data[kind]
                continue
            names = [n for n, _, _ in files[kind]]
            if verbose:
                mb = sum(s for _, s, _ in files[kind]) / 1e6
                print(f"   Đọc {label}: {', '.join(names)} ({mb:.0f} MB)…", flush=True)
            try:
                data[kind] = load_meta_kind(kind, [META_DIR / n for n in names])
                info[kind] = f"{len(data[kind])} video"
            except (OSError, ValueError, MemoryError) as e:
                info[kind] = f"LỖI đọc {', '.join(names)}: {e}"
                print(f"   !! {label}: {info[kind]} → dùng backend", flush=True)
        self.data, self.info, self.sig = data, info, sig  # thay 1 lần, request đang chạy vẫn dùng bản cũ
        self.checked = time.time()

    def refresh_if_stale(self):
        # Chép thêm / thay file trong data/meta lúc đang chạy: tự đọc lại (kiểm tra tối đa 30s/lần, chạy nền).
        if time.time() - self.checked < 30 or not self.lock.acquire(blocking=False):
            return
        self.checked = time.time()

        def run():
            try:
                self.load()
            finally:
                self.lock.release()
        threading.Thread(target=run, daemon=True).start()


META = Meta()
BACKEND_FPS = {"value": None, "at": 0.0}


def backend_fps():
    """/api/video-fps của backend (nhớ lại) — dùng khi data/meta chưa có video_metadata.json."""
    if BACKEND_FPS["value"] is None and time.time() - BACKEND_FPS["at"] > 10:
        BACKEND_FPS["at"] = time.time()
        try:
            conn = connect(BACKEND, 5)
            conn.request("GET", BACKEND.path + "/api/video-fps", headers={"Host": BACKEND.netloc})
            r = conn.getresponse()
            body = r.read()
            conn.close()
            v = json.loads(body) if r.status == 200 else None
            if isinstance(v, dict):
                BACKEND_FPS["value"] = v
        except (OSError, ValueError):
            pass
    return BACKEND_FPS["value"]


def fps_of(vid):
    meta = META.data.get("fps")
    if meta is not None:  # giống ResourceManager.get_video_fps (metadata → mặc định 25)
        rec = meta.get(vid)
        fps = rec.get("fps") if isinstance(rec, dict) else None
        return float(fps) if isinstance(fps, (int, float)) and fps > 0 else DEFAULT_FPS
    b = backend_fps()
    if b is None:
        return None
    fps = _num((b.get("overrides") or {}).get(vid, b.get("default_fps", DEFAULT_FPS)))
    return fps if fps > 0 else None


def local_api(path, query):
    """Trả lời API OCR/ASR/keyframe/FPS từ data/meta. None = không có ở máy → hỏi backend."""
    META.refresh_if_stale()
    d = META.data
    if not d:
        return None
    if path == "/api/video-fps":
        meta = d.get("fps")
        if meta is None:
            return None
        overrides = {}
        for vid, rec in meta.items():  # giống get_video_fps của backend
            try:
                fps = float(rec.get("fps", DEFAULT_FPS))
            except (AttributeError, TypeError, ValueError):
                continue
            if fps != DEFAULT_FPS:
                overrides[vid] = fps
        return {"default_fps": DEFAULT_FPS, "overrides": overrides}
    m = re.fullmatch(r"/api/videos/([A-Za-z0-9_-]+)/(ocr|asr|frames)", path)
    if not m:
        return None
    vid, what = m.groups()
    if what == "ocr":
        rows = d.get("ocr", {}).get(vid.lower())
        return None if rows is None else [{"doc_id": doc, "video_id": vid, "frame_id": fr, "text": text} for fr, doc, text in rows]
    if what == "asr":
        return d.get("asr", {}).get(vid)
    view = (urllib.parse.parse_qs(query).get("view") or ["boundaries"])[0]
    if view == "boundaries":
        events = d.get("kcp", {}).get(vid)
        fps = fps_of(vid) if events else None
        if not fps:
            return None
        grouped = {}
        for fr, ev in events.items():
            grouped.setdefault(ev, []).append(fr)
        rows = sorted(((ev, sorted(frs)) for ev, frs in grouped.items()), key=lambda r: (r[1][0], r[0]))
        data = [{"frame_id": frs[0], "timestamp_seconds": round(frs[0] / fps, 3), "event_id": ev,
                 "start_frame": frs[0], "end_frame": frs[-1], "is_boundary": True} for ev, frs in rows]
    elif view == "all":
        frames = d.get("frames", {}).get(vid)
        fps = fps_of(vid) if frames else None
        if not fps:
            return None
        data = [{"frame_id": f, "timestamp_seconds": round(f / fps, 3)} for f in frames]
    else:
        return None
    return {"success": True, "data": data, "video_id": vid, "view": view, "count": len(data)}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                      ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8"}
    static = False

    def log_message(self, *args):
        pass

    def end_headers(self):
        if self.static:
            self.send_header("Cache-Control", "no-cache")  # luôn lấy bản mới của index/app/style
        super().end_headers()

    def _route(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health" or path.startswith(PROXY_PREFIXES):
            if self.headers.get("Upgrade", "").lower() == "websocket":
                return self._ws()
            if self.command in ("GET", "HEAD"):
                local = local_api(path, urllib.parse.urlsplit(self.path).query)
                if local is not None:
                    return self._json(200, local, (("X-Source", "local"),))
            return self._forward(BACKEND, BACKEND.path + self.path, ARGS.timeout)
        if path.startswith("/dres/"):
            return self._dres(path)
        if path in ("/media", "/media/"):
            return self._json(200, {"proxy": True, "videos": True, "frames": True, "asr": False,
                                    "local_videos": len(VIDEOS), "local_frame_dirs": len(FRAMES)})
        m = re.fullmatch(r"/media/videos/([A-Za-z0-9_-]+)\.mp4", path)
        if m:
            p = local_video(m.group(1))
            return self._file(p, "video/mp4") if p else self._forward(BACKEND, f"{BACKEND.path}/api/videos/{m.group(1)}", ARGS.timeout, source="server")
        m = re.fullmatch(r"/media/frames/([A-Za-z0-9_-]+)/f_(\d+)\.jpg", path)
        if m:
            p = local_frame(m.group(1), int(m.group(2)))
            return self._file(p, IMG_TYPES.get(p.suffix.lower(), "image/jpeg")) if p else \
                self._forward(BACKEND, f"{BACKEND.path}/api/frames/{m.group(1)}/{int(m.group(2))}", ARGS.timeout, source="server")
        if path == "/media/dirs":  # GET: danh sách thư mục video · POST {"dirs": [...]}: lưu data/video_dirs.txt
            if self.command == "POST":
                return self._save_dirs()
            rescan_now()
            return self._json(200, dirs_info())
        if path == "/media/find":  # ?q=<Video ID người dùng gõ>
            return self._json(200, find_video((urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("q") or [""])[0]))
        if path.startswith("/media/"):
            return self._json(404, {"detail": "không có"})
        if self.command in ("GET", "HEAD"):
            self.static = True
            return super().do_GET() if self.command == "GET" else super().do_HEAD()
        self._json(405, {"detail": "method not allowed"})

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = _route

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def _json(self, status, obj, extra=()):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _save_dirs(self):
        if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            return self._json(403, {"error": "Chỉ sửa được thư mục video từ chính máy chạy server.py."})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            dirs = list(dict.fromkeys(clean_dir(d) for d in body.get("dirs", []) if str(d).strip()))
        except (ValueError, AttributeError, TypeError):
            return self._json(400, {"error": "Dữ liệu không hợp lệ."})
        old = set(read_dirs_file())  # thư mục đã lưu mà tạm không có (ổ rời chưa cắm) vẫn giữ được
        bad = [d for d in dirs if d not in old and not Path(d).is_dir()]
        if bad:
            return self._json(400, {"error": "Không tìm thấy thư mục: " + ", ".join(bad), "bad": bad})
        try:
            write_dirs_file(dirs)
        except OSError as e:
            return self._json(500, {"error": f"Không lưu được {DIRS_FILE}: {e}"})
        rescan_now()
        return self._json(200, dirs_info())

    # ── Chuyển tiếp HTTP (stream, giữ Range / 206) ──
    def _forward(self, url, target, timeout, source=None, extra_headers=None, resp_headers=()):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in HOP and k.lower() not in ("host", "content-length", "x-dres-base", "origin", "referer", "cookie")}
        headers["Host"] = url.netloc
        headers.update(extra_headers or {})
        conn = connect(url, timeout)
        try:
            conn.request(self.command, target, body=body, headers=headers)
            resp = conn.getresponse()
        except OSError as e:
            conn.close()
            name = "DRES" if resp_headers else "backend"
            return self._json(502, {"success": False, "status": False,
                                    "error": f"server.py không kết nối được {name} {url.scheme}://{url.netloc}: {e}",
                                    "description": f"Không kết nối được {name}: {e}"}, resp_headers)
        try:
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in HOP and not k.lower().startswith("access-control-"):
                    self.send_header(k, v)
            if source:
                self.send_header("X-Source", source)
            for k, v in resp_headers:
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except OSError:
            pass  # trình duyệt huỷ request (tua video, đổi kết quả…)
        finally:
            conn.close()

    # ── DRES: /dres/api/v2/... + header X-DRES-Base: https://eventretrieval.one ──
    def _dres(self, path):
        relay = (("X-DRES-Relay", "1"),)
        base = urllib.parse.urlsplit((self.headers.get("X-DRES-Base") or "").rstrip("/"))
        if base.scheme not in ("http", "https") or not base.hostname or not path.startswith("/dres/api/v2/"):
            return self._json(400, {"status": False, "description": "Thiếu/ sai địa chỉ DRES"}, relay)
        target = base.path + self.path[len("/dres"):]
        self._forward(base, target, 20, extra_headers={"Accept": "application/json"}, resp_headers=relay)

    # ── WebSocket: gửi lại request bắt tay rồi nối thẳng 2 socket ──
    def _ws(self):
        port = BACKEND.port or (443 if BACKEND.scheme == "https" else 80)
        try:
            up = socket.create_connection((BACKEND.hostname, port), timeout=10)
            if BACKEND.scheme == "https":
                up = ssl._create_unverified_context().wrap_socket(up, server_hostname=BACKEND.hostname)
        except OSError as e:
            return self._json(502, {"success": False, "error": f"WebSocket: không kết nối được backend {ARGS.backend}: {e}"})
        lines = [f"{self.command} {BACKEND.path}{self.path} HTTP/1.1", f"Host: {BACKEND.netloc}"]
        lines += [f"{k}: {v}" for k, v in self.headers.items() if k.lower() != "host"]
        up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        up.settimeout(None)
        client = self.connection
        client.settimeout(None)

        def pump(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                for s in (src, dst):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        t = threading.Thread(target=pump, args=(up, client), daemon=True)
        t.start()
        pump(client, up)
        t.join(timeout=5)
        up.close()
        self.close_connection = True

    # ── File cục bộ (video có Range để tua) ──
    def _file(self, path, ctype):
        size = path.stat().st_size
        start, end = 0, size - 1
        rng = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if rng and (rng.group(1) or rng.group(2)):
            if rng.group(1):
                start = int(rng.group(1))
                end = int(rng.group(2)) if rng.group(2) else size - 1
            else:
                start = max(0, size - int(rng.group(2)))
            start, end = min(start, size - 1), min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "max-age=3600")
        self.send_header("X-Source", "local")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    data = f.read(min(256 * 1024, left))
                    if not data:
                        break
                    self.wfile.write(data)
                    left -= len(data)
        except OSError:
            pass


class Server(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"  # Windows: tránh 2 server cùng chiếm 1 cổng
    daemon_threads = True


def check_backend():
    try:
        conn = connect(BACKEND, 4)
        conn.request("GET", BACKEND.path + "/health", headers={"Host": BACKEND.netloc})
        r = conn.getresponse()
        body = r.read(200).decode("utf-8", "replace").strip()
        conn.close()
        return r.status == 200, f"HTTP {r.status} {body}"
    except OSError as e:
        return False, str(e)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    for b in ("batch1", "batch2", "meta"):
        (DATA_ROOT / b).mkdir(parents=True, exist_ok=True)
    try:
        httpd = Server(("0.0.0.0", ARGS.port), partial(Handler, directory=str(ROOT)))
    except OSError as e:
        sys.exit(f"Không mở được cổng {ARGS.port} ({e}).\n"
                 f"Có thể server.py/serve.py cũ vẫn đang chạy: tắt cửa sổ đó (Ctrl+C) hoặc chạy python server.py --port 8090")
    scan()
    META.load(verbose=True)
    ok, detail = check_backend()
    print("=" * 64)
    print(f" AIC final frontend : http://localhost:{ARGS.port}")
    print(f" Backend            : {ARGS.backend}  ->  {'OK' if ok else 'KHÔNG KẾT NỐI ĐƯỢC'} ({detail})")
    if not ok:
        print("   -> Kiểm tra SSH tunnel (ssh -L 8602:localhost:8602 <user>@<server>) và backend trên server.")
        print("      Trang vẫn mở được và tự thử lại mỗi 5 giây.")
    print(f" Dữ liệu cục bộ     : {len(VIDEOS)} video, {len(FRAMES)} thư mục keyframe — thiếu ở máy thì tự lấy từ backend")
    for d in SCAN["per"].values():
        state = f"{d['videos']} video" + (f", {d['frame_dirs']} thư mục keyframe" if d["frame_dirs"] else "") if d["exists"] else "KHÔNG TỒN TẠI"
        print(f"   {d['path']}  [{d['source']}]  → {state}")
    print("   Thêm thư mục ở ổ khác: ⚙️ Cài đặt → Thư mục video trên máy (hoặc sửa data/video_dirs.txt)")
    meta = [f"{label} {META.info[k]}" for k, label, _ in META_KINDS if k in META.info]
    print(f" OCR/ASR/keyframe   : {' · '.join(meta) if meta else 'chưa có — chép file gốc của backend vào data/meta/ (xem README)'}")
    if META.unknown:
        print(f"                      bỏ qua (không nhận ra tên): {', '.join(META.unknown)}")
    print("=" * 64)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Đã dừng.")
