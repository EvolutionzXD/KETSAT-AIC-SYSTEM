"""FastAPI HTTP API wrapping src.pipeline.search_engine.SearchEngine.

backend/main.py is legacy code built against a different (Milvus/open_clip)
retrieval stack and is not compatible with the current PE-Core/BEiT-3/OCR/
ASR/caption hybrid pipeline ?????????????????? this module is the replacement.
"""
from __future__ import annotations

import csv
import io
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Generic, List, Literal, Optional, TypeVar
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from loguru import logger
from PIL import Image
from pydantic import BaseModel, Field

import asyncio
import base64
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

try:
    import boto3
    b2_client = boto3.client(
        's3',
        endpoint_url='https://s3.us-east-005.backblazeb2.com',
        aws_access_key_id='0058387584b039a0000000004',
        aws_secret_access_key='K005WEDHLEl7PXurwZM9L5GrdOvpY3A',
        config=boto3.session.Config(signature_version='s3v4')
    )
    # Configure CORS on the bucket so browsers can fetch directly
    try:
        b2_client.put_bucket_cors(
            Bucket='aic2026-cli',
            CORSConfiguration={
                'CORSRules': [{
                    'AllowedOrigins': ['*'],
                    'AllowedMethods': ['GET', 'HEAD'],
                    'AllowedHeaders': ['Authorization', 'Range', '*'],
                    'ExposeHeaders': ['Content-Length', 'Content-Type'],
                    'MaxAgeSeconds': 3600,
                }]
            }
        )
        logger.info("[B2] CORS configured on bucket aic2026-cli")
    except Exception as _cors_err:
        logger.warning(f"[B2] Could not set bucket CORS (non-fatal): {_cors_err}")
except ImportError:
    b2_client = None
    logger.warning("boto3 not installed, B2 presigned URLs will fail")

# ── B2 native download-authorization token (for direct browser→B2) ──
_B2_DL_AUTH_CACHE: dict = {}
_B2_EXECUTOR = ThreadPoolExecutor(max_workers=1)
# applicationKeyId (long form) – needed for b2_authorize_account
B2_ACCOUNT_ID = "0058387584b039a0000000004"
B2_APPLICATION_KEY = "K005WEDHLEl7PXurwZM9L5GrdOvpY3A"
B2_BUCKET_NAME = "aic2026-cli"
# Known values from 'b2 account get' – skip re-auth when cached
_B2_KNOWN = {
    "api_url": "https://api005.backblazeb2.com",
    "download_url": "https://f005.backblazeb2.com",
}

def _b2_get_download_auth_sync() -> dict:
    """Calls B2 native API to get a bucket-wide download auth token.
    Cached for 23h so subsequent calls return immediately."""
    now = time.time()
    cached = _B2_DL_AUTH_CACHE.get('v1')
    if cached and cached['expires_at'] > now + 300:
        return cached

    # 1. b2_authorize_account
    creds = base64.b64encode(f"{B2_ACCOUNT_ID}:{B2_APPLICATION_KEY}".encode()).decode()
    req = urllib.request.Request(
        "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
        headers={"Authorization": f"Basic {creds}"}
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        auth = json.loads(r.read())

    api_url = auth["apiUrl"]
    auth_token = auth["authorizationToken"]
    download_url = auth["downloadUrl"]

    # 2. b2_list_buckets → get bucketId
    # NOTE: accountId here must be the SHORT account ID, not the keyId
    B2_SHORT_ACCOUNT_ID = "8387584b039a"
    data = json.dumps({"accountId": B2_SHORT_ACCOUNT_ID, "bucketName": B2_BUCKET_NAME}).encode()
    req2 = urllib.request.Request(
        f"{api_url}/b2api/v2/b2_list_buckets",
        data=data,
        headers={"Authorization": auth_token, "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req2, timeout=15) as r:
        buckets_resp = json.loads(r.read())

    bucket_id = next(
        (b["bucketId"] for b in buckets_resp.get("buckets", []) if b["bucketName"] == B2_BUCKET_NAME),
        None
    )
    if not bucket_id:
        raise ValueError(f"Bucket '{B2_BUCKET_NAME}' not found")

    # 2b. Set CORS via native B2 API (allows browser direct download)
    cors_rules = [{
        "corsRuleName": "allowBrowserDownload",
        "allowedOrigins": ["*"],
        "allowedHeaders": ["*"],
        "allowedOperations": ["b2_download_file_by_name", "b2_download_file_by_id", "s3_get"],
        "exposeHeaders": ["content-length", "content-type", "content-range", "accept-ranges", "x-bz-content-sha1"],
        "maxAgeSeconds": 3600
    }]
    try:
        cors_data = json.dumps({"accountId": acc_id, "bucketId": bucket_id, "corsRules": cors_rules}).encode()
        cors_req = urllib.request.Request(
            f"{api_url}/b2api/v2/b2_update_bucket",
            data=cors_data,
            headers={"Authorization": auth_token, "Content-Type": "application/json"}
        )
        with urllib.request.urlopen(cors_req, timeout=10) as r:
            r.read()
        logger.info("[B2] CORS rules set on bucket via native API")
    except Exception as _ce:
        logger.warning(f"[B2] Could not set CORS (non-fatal): {_ce}")

    # 3. b2_get_download_authorization (23 hours)
    VALID_SECS = 82800
    data3 = json.dumps({
        "bucketId": bucket_id,
        "fileNamePrefix": "",
        "validDurationInSeconds": VALID_SECS
    }).encode()
    req3 = urllib.request.Request(
        f"{api_url}/b2api/v2/b2_get_download_authorization",
        data=data3,
        headers={"Authorization": auth_token, "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req3, timeout=15) as r:
        dl_auth = json.loads(r.read())

    result = {
        "token": dl_auth["authorizationToken"],
        "download_url": download_url,
        "bucket": B2_BUCKET_NAME,
        "expires_in": VALID_SECS,
        "expires_at": now + VALID_SECS,
    }
    _B2_DL_AUTH_CACHE['v1'] = result
    logger.info(f"[B2] Download auth token refreshed, valid for {VALID_SECS}s")
    return result

from src.config import get_settings
from src.media import hls_service
from src.pipeline.search_engine import SearchEngine, get_search_engine

from backend.team_sync import router as team_router
from backend.team_sync import ws_router as team_ws_router
from backend.team_sync import ws_sync_router
from backend.dres_proxy import router as dres_router
from backend.submission_csv import router as submission_router

T = TypeVar("T")

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_SOLOAI_FILENAME_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.csv$", re.IGNORECASE
)


class APIResponse(BaseModel, Generic[T]):
    """Consistent envelope for all API responses."""

    success: bool
    data: Optional[T] = None
    error: Optional[str] = None
    meta: Dict[str, Any] = Field(default_factory=dict)


class Message(BaseModel):
    role: str
    content: str


class KISRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=10, gt=0, le=1000)
    diversify_for_ui: bool = True
    # Optional separate text for the OCR/ASR rankers (see
    # HybridSearchEngine.search) ?????????????????? a user-typed on-screen-text/speech guess,
    # or a DeepSeek-extracted sub-query. None reuses `query` for that
    # ranker, reproducing the prior single-query behavior exactly.
    ocr_query: Optional[str] = None
    asr_query: Optional[str] = None
    deepseek_vision: bool = False
    deepseek_rerank: bool = False
    # Standard is the fast production path. Video-lock is an explicit,
    # opt-in rescue path and enables the two-pass DeepSeek visual endpoint.
    search_mode: Literal["standard", "video_lock"] = "standard"
    fusion_mode: Literal["late", "early"] = "late"
    # Optional standard-search ablation. ``none`` preserves the existing
    # Standard Early/Late behavior; the other values are the explicit
    # Multi-mode choices exposed by the frontend.
    multimodal_mode: Literal["none", "only_visual", "visual_ocr", "visual_asr"] = "none"


class SelectedFrame(BaseModel):
    """A frame clicked by the user, used to identify a video to refine."""

    video_id: str = Field(min_length=1, max_length=128)
    frame_id: int = Field(ge=0)


class SelectedVideoFilterRequest(BaseModel):
    """Second-stage local visual search over user-selected videos only."""

    query: str = Field(min_length=1)
    selected_frames: List[SelectedFrame] = Field(min_length=1, max_length=20)
    top_k_per_video: int = Field(default=100, gt=0, le=600)
    output_limit: int = Field(default=100, gt=0, le=100)


class TRAKERequest(BaseModel):
    """Ordered sequence of event descriptions to align within one video."""

    events: List[str] = Field(min_length=1, max_length=10)
    top_k_videos: int = Field(default=10, gt=0, le=100)
    per_event_pool: int = Field(default=200, gt=0, le=2000)
    max_missing_events: int = Field(default=0, ge=0)
    # Optional explicit anchor/video lock for DeepSeek Vision TRAKE.
    anchor_query: Optional[str] = None
    video_id: Optional[str] = None
    anchor_frame_id: Optional[int] = Field(default=None, ge=0)
    window_seconds: float = Field(default=30.0, gt=0.0, le=300.0)
    # The locked-video DeepSeek pass uses the extracted 5 FPS keyframe grid
    # by default; callers can still lower it for a cheaper exploratory scan.
    scan_fps: float = Field(default=5.0, gt=0.0, le=10.0)


class CKISRequest(BaseModel):
    messages: List[Message] = Field(default_factory=list)
    current_query: str = Field(min_length=1)
    top_k: int = Field(default=10, gt=0, le=1000)
    diversify_for_ui: bool = True


class QARequest(BaseModel):
    question: str = Field(min_length=1)
    top_k: int = Field(default=10, gt=0, le=1000)
    diversify_for_ui: bool = True
    deepseek_vision: bool = False
    deepseek_rerank: bool = False
    fusion_mode: Literal["late", "early"] = "late"
    search_mode: Literal["standard", "video_lock"] = "standard"
    multimodal_mode: Literal["none", "only_visual", "visual_ocr", "visual_asr"] = "none"
    # Kept optional for clients that translate the visual query before sending
    # it.  The new frontend fills these from the original user text so the
    # OCR/ASR lanes never depend on a manually maintained second textarea.
    ocr_query: Optional[str] = None
    asr_query: Optional[str] = None


class MomentsRequest(BaseModel):
    """docs/KCP_VTG_RUNBOOK.md step 3 input: coarse moments for VTG grounding."""

    query: str = Field(min_length=1)
    top_k_moments: int = Field(default=10, gt=0, le=100)


class SoloaiSubmissionRequest(BaseModel):
    """Validated CSV payload for the server-side SOLOAI export."""

    query_filename: str = Field(min_length=1, max_length=128)
    task: str = Field(pattern=r"^(kis|vqa|trake)$")
    content: str = Field(min_length=1, max_length=2_000_000)
    items: List[Dict[str, Any]] = Field(default_factory=list, max_length=100)
    answers: List[str] = Field(default_factory=list, max_length=100)


class B2BatchPresignRequest(BaseModel):
    """Keys to presign for direct browser-to-B2 GET (no custom header)."""

    keys: List[str] = Field(min_length=1, max_length=500)
    expires_in: int = Field(default=3600, ge=60, le=82800)


def _soloai_filename(raw: str) -> str:
    """Accept only a safe basename below SOLOAI_OUTPUT_DIR."""

    name = str(raw).strip()
    if (
        not _SOLOAI_FILENAME_RE.fullmatch(name)
        or name in {".", ".."}
        or Path(name).name != name
        or any(ord(char) < 32 for char in name)
    ):
        raise HTTPException(status_code=400, detail="invalid SOLOAI filename")
    return name


def _parse_soloai_csv(task: str, content: str) -> List[List[str]]:
    """Validate organizer-facing CSV rows before writing any bytes."""

    if "\x00" in content:
        raise HTTPException(status_code=400, detail="SOLOAI CSV contains NUL")
    rows = [
        row for row in csv.reader(io.StringIO(content))
        if any(cell.strip() for cell in row)
    ]
    if not rows:
        raise HTTPException(status_code=400, detail="SOLOAI CSV is empty")
    if len(rows) > 100:
        raise HTTPException(status_code=400, detail="SOLOAI CSV exceeds 100 rows")

    for row in rows:
        if task == "kis":
            if len(row) != 2:
                raise HTTPException(
                    status_code=400, detail="KIS row must be video_id,frame_id"
                )
            frame_values = row[1:]
        elif task == "vqa":
            if len(row) != 3 or not row[2].strip():
                raise HTTPException(
                    status_code=400,
                    detail="QA row must be video_id,frame_id,answer",
                )
            if len(row[2]) > 100:
                raise HTTPException(
                    status_code=400, detail="QA answer exceeds 100 characters"
                )
            frame_values = row[1:2]
        else:
            if len(row) < 2:
                raise HTTPException(
                    status_code=400, detail="TRAKE row needs video_id and frame_ids"
                )
            frame_values = row[1:]

        if not _VIDEO_ID_RE.fullmatch(row[0].strip()):
            raise HTTPException(
                status_code=400, detail="invalid video_id in SOLOAI CSV"
            )
        for raw_frame in frame_values:
            # TRAKE accepts separate columns or comma-separated frame values.
            for token in raw_frame.split(","):
                try:
                    frame = int(token.strip())
                except (TypeError, ValueError):
                    raise HTTPException(
                        status_code=400, detail="frame_id must be an integer"
                    )
                if frame < 0:
                    raise HTTPException(
                        status_code=400, detail="frame_id must be non-negative"
                    )
    return rows


def _write_soloai_submission(settings: Any, body: SoloaiSubmissionRequest) -> Dict[str, Any]:
    """Atomically write a validated CSV below the configured output root."""

    filename = _soloai_filename(body.query_filename)
    _parse_soloai_csv(body.task, body.content)
    output_dir = Path(settings.soloai_output_dir).expanduser()
    if not output_dir.is_absolute():
        output_dir = Path.cwd() / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir = output_dir.resolve()
    target = (output_dir / filename).resolve()
    if target.parent != output_dir:
        raise HTTPException(status_code=400, detail="invalid SOLOAI output path")

    temporary = output_dir / ("." + filename + "." + uuid4().hex + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="") as handle:
            handle.write(body.content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temporary), str(target))
    except OSError as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        logger.exception("SOLOAI server save failed: {}", exc)
        raise HTTPException(status_code=500, detail="cannot write SOLOAI output")
    return {
        "saved": True,
        "task": body.task,
        "output_filename": filename,
        "bytes": len(body.content.encode("utf-8")),
    }


def _envelope(data: Any, started_at: float, **meta: Any) -> Dict[str, Any]:
    return {
        "success": True,
        "data": data,
        "error": None,
        "meta": {"elapsed_ms": round((time.time() - started_at) * 1000, 1), **meta},
    }




@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logger.info(
        "Loading Final_AIC SearchEngine ({} visual, {} text)...",
        settings.visual_index_backend,
        settings.text_index_backend,
    )
    engine = get_search_engine()
    if not settings.startup_warmup_enabled:
        logger.info(
            "Startup warmup disabled; indexes and encoders remain lazy "
            "until the first request"
        )
        yield
        return
    # Warm the exact ResourceManager owned by this SearchEngine before accepting
    # requests. Keeping this scoped to the engine also preserves test doubles
    # and avoids constructing a second singleton.
    resource_manager = getattr(engine, "_rm", None)
    if resource_manager is not None and hasattr(resource_manager, "preload_all"):
        resource_manager.preload_all()
    # Resource preload reads indexes and constructs lazy encoder wrappers;
    # a real warmup search is still required to move the visual models to
    # their configured GPUs and prevent the first user query paying that cost.
    engine.warmup()
    logger.info("SearchEngine ready (resources warmed)")
    yield

def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="AIC2026 Search API",
        description="HTTP API over the PE-Core/BEiT-3/OCR/ASR/caption hybrid search engine",
        version="1.0.0",
        lifespan=lifespan,
    )

    origins = (
        ["*"]
        if settings.cors_origins == "*"
        else [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=settings.cors_origins != "*",
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    # Real-time team collaboration ?????????????????? presence, shared submission queue,
    # shared DRES session, TRAKE coordination, frame marking, shared
    # history. In-memory only (see backend/team_sync.py), independent of
    # SearchEngine/lifespan above.
    app.include_router(team_router)
    app.include_router(team_ws_router)
    app.include_router(ws_sync_router)
    # Server-side DRES proxy (avoids the browser hitting a self-signed/
    # cross-origin DRES host directly) ?????????????????? see backend/dres_proxy.py.
    app.include_router(dres_router)
    app.include_router(submission_router)

    @app.get("/health")
    async def health() -> Dict[str, Any]:
        return {"status": "ok"}


    @app.post("/api/submission/solo")
    def save_soloai_submission(
        request: SoloaiSubmissionRequest,
    ) -> Dict[str, Any]:
        """Save validated competition CSV under SOLOAI_OUTPUT_DIR."""

        started_at = time.time()
        result = _write_soloai_submission(settings, request)
        return _envelope(result, started_at)

    @app.get("/api/stats")
    async def stats(
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        started_at = time.time()
        return _envelope(engine.get_stats(), started_at)

    # Search routes call synchronous, CPU/GPU-bound SearchEngine methods
    # (FAISS search, text encoding). Declared as plain `def` so FastAPI runs
    # them in its threadpool instead of blocking the single event loop
    # (default api_workers=1) for the duration of every search.
    @app.post("/api/search/kis")
    def search_kis(
        request: KISRequest,
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        started_at = time.time()
        results = engine.search_kis(
            request.query,
            top_k=request.top_k,
            diversify_for_ui=request.diversify_for_ui,
            ocr_query=request.ocr_query,
            asr_query=request.asr_query,
            deepseek_vision=(request.deepseek_vision or
                             request.search_mode == "video_lock"),
            deepseek_rerank=request.deepseek_rerank,
            search_mode=request.search_mode,
            fusion_mode=request.fusion_mode,
            multimodal_mode=request.multimodal_mode,
        )
        return _envelope(results, started_at, count=len(results),
                         search_mode=request.search_mode,
                         fusion_mode=request.fusion_mode,
                         multimodal_mode=request.multimodal_mode)

    @app.post("/api/search/selected-videos")
    def search_selected_videos(
        request: SelectedVideoFilterRequest,
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        """Refine up to 100 best frames in videos selected in the result grid.

        The clicked frame is only the selection anchor.  Ranking is performed
        by the visual rankers over the complete selected-video ranges, so the
        endpoint cannot accidentally search the global candidate pool or
        return a second frame from an unrelated video.
        """

        normalized: List[Dict[str, Any]] = []
        seen = set()
        for selected in request.selected_frames:
            video_id = str(selected.video_id).strip()
            if not _VIDEO_ID_RE.fullmatch(video_id):
                raise HTTPException(status_code=422, detail="invalid video_id")
            if video_id in seen:
                continue
            seen.add(video_id)
            normalized.append({
                "video_id": video_id,
                "frame_id": int(selected.frame_id),
            })
        if not normalized:
            raise HTTPException(status_code=422, detail="select at least one video")

        started_at = time.time()
        try:
            results = engine.search_selected_video_frames(
                request.query,
                normalized,
                top_k_per_video=request.top_k_per_video,
                output_limit=request.output_limit,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return _envelope(
            results,
            started_at,
            count=len(results),
            selected_video_count=len(normalized),
            filter_scope="selected_video_visual_local",
        )

    # KIS-V: search by example image (final-round requirement, confirmed
    # 2026-08-15 ?????????????????? see docs/SEARCH_API_RUNBOOK.md). Multipart, not JSON,
    # since the query is a file rather than text.
    @app.post("/api/search/kis_by_image")
    def search_kis_by_image(
        image: UploadFile = File(...),
        top_k: int = Form(default=10, gt=0, le=1000),
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        started_at = time.time()
        try:
            pil_image = Image.open(image.file)
            pil_image.load()
        except Exception as exc:
            raise HTTPException(400, f"Kh????????ng ????????????????????????c ?????????????????????????????????c ????????????nh: {exc}")
        results = engine.search_kis_by_image(pil_image, top_k=top_k)
        return _envelope(results, started_at, count=len(results))

    @app.post("/api/search/trake")
    def search_trake(
        request: TRAKERequest,
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        started_at = time.time()
        try:
            kwargs = {
                "top_k_videos": request.top_k_videos,
                "per_event_pool": request.per_event_pool,
                "max_missing_events": request.max_missing_events,
            }
            if (
                request.anchor_query is not None
                or request.video_id is not None
                or request.anchor_frame_id is not None
            ):
                kwargs.update({
                    "anchor_query": request.anchor_query,
                    "video_id": request.video_id,
                    "anchor_frame_id": request.anchor_frame_id,
                    "window_seconds": request.window_seconds,
                    "scan_fps": request.scan_fps,
                })
            results = engine.search_trake(request.events, **kwargs)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return _envelope(results, started_at, count=len(results))

    @app.post("/api/search/ckis")
    def search_ckis(
        request: CKISRequest,
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        started_at = time.time()
        results = engine.search_ckis(
            [m.model_dump() for m in request.messages],
            request.current_query,
            top_k=request.top_k,
            diversify_for_ui=request.diversify_for_ui,
        )
        return _envelope(results, started_at, count=len(results))

    @app.post("/api/search/qa")
    def search_qa(
        request: QARequest,
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        started_at = time.time()
        results = engine.search_qa(
            request.question,
            top_k=request.top_k,
            diversify_for_ui=request.diversify_for_ui,
            # Lock-Video is an explicit end-to-end mode.  QA must activate
            # the same VTG/visual refinement path as KIS; previously the
            # KIS route inferred this from search_mode while QA silently
            # stayed on the coarse path.
            deepseek_vision=(request.deepseek_vision or
                             request.search_mode == "video_lock"),
            deepseek_rerank=request.deepseek_rerank,
            fusion_mode=request.fusion_mode,
            search_mode=request.search_mode,
            multimodal_mode=request.multimodal_mode,
            ocr_query=request.ocr_query,
            asr_query=request.asr_query,
        )
        return _envelope(results, started_at, count=len(results),
                         search_mode=request.search_mode,
                         fusion_mode=request.fusion_mode,
                         multimodal_mode=request.multimodal_mode)

    @app.post("/api/search/moments")
    def search_moments(
        request: MomentsRequest,
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        started_at = time.time()
        try:
            results = engine.search_moments(
                request.query, top_k_moments=request.top_k_moments
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return _envelope(results, started_at, count=len(results))

    @app.get("/api/videos/{video_id}/frames")
    def list_video_frames(
        video_id: str,
        view: str = "boundaries",
        engine: SearchEngine = Depends(get_search_engine),
    ) -> Dict[str, Any]:
        """List keyframes for the bottom frame-extraction strip."""
        if not _VIDEO_ID_RE.fullmatch(video_id):
            raise HTTPException(status_code=400, detail="invalid video_id")
        try:
            frames = engine.get_video_frame_timeline(video_id, view=view)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        if not frames:
            raise HTTPException(status_code=404, detail="video frames not found")
        return {
            "success": True,
            "data": frames,
            "video_id": video_id,
            "view": view,
            "count": len(frames),
        }

    @app.get("/api/b2_download_token")
    async def get_b2_download_token():
        """Return a B2 download authorization token (23h valid) for direct
        browser-to-B2 downloads. Cached server-side after the first call."""
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(_B2_EXECUTOR, _b2_get_download_auth_sync)
            # Return everything except the internal expires_at timestamp
            return {k: v for k, v in result.items() if k != 'expires_at'}
        except Exception as exc:
            logger.error(f"[B2] Failed to get download token: {exc}")
            raise HTTPException(status_code=502, detail=f"B2 auth error: {exc}")

    @app.get("/api/b2_media/{path:path}")
    def proxy_b2_media(path: str):
        """Fallback: redirect to a per-file pre-signed URL.
        Prefer /api/b2_download_token for bulk direct-to-B2 access."""
        if b2_client is None:
            raise HTTPException(status_code=500, detail="B2 Client not initialized (boto3 missing?)")
        key = path.lstrip("/")
        url = b2_client.generate_presigned_url(
            ClientMethod='get_object',
            Params={'Bucket': 'aic2026-cli', 'Key': key},
            ExpiresIn=3600
        )
        return RedirectResponse(url=url)

    @app.post("/api/b2_media_batch")
    def presign_b2_media_batch(body: B2BatchPresignRequest) -> Dict[str, Any]:
        """Batch-generate S3-style presigned URLs (query-string signature,
        no custom header) for many B2 keys in one round trip. Presigning is a
        local crypto operation (no B2 network call), so this stays fast even
        for hundreds of keys. Unlike /api/b2_download_token's header-based
        token, these URLs need no Authorization header, so the browser skips
        CORS preflight per-frame entirely."""
        started_at = time.time()
        if b2_client is None:
            raise HTTPException(status_code=500, detail="B2 Client not initialized (boto3 missing?)")
        urls = [
            b2_client.generate_presigned_url(
                ClientMethod="get_object",
                Params={"Bucket": "aic2026-cli", "Key": key.lstrip("/")},
                ExpiresIn=body.expires_in,
            )
            for key in body.keys
        ]
        return _envelope({"urls": urls}, started_at, count=len(urls))

    @app.get("/api/frames/{video_id}/{frame_id}")
    def get_frame(
        video_id: str,
        frame_id: int,
        engine: SearchEngine = Depends(get_search_engine),
    ) -> FileResponse:
        if not _VIDEO_ID_RE.match(video_id):
            # Also the only path-traversal defense this route needs: every
            # path get_frame_path can return is built from this validated
            # video_id (or, for the manifest branch, from trusted local
            # JSON content) plus an integer frame_id ?????????????????? no raw user input
            # is ever concatenated into a filesystem path.
            raise HTTPException(status_code=400, detail="invalid video_id")
        frame_path = engine.get_frame_path(video_id, frame_id)
        if frame_path is None or not frame_path.exists():
            raise HTTPException(status_code=404, detail="frame not found")
        return FileResponse(frame_path, media_type="image/jpeg")

    @app.get("/api/videos/{video_id}")
    def get_video(video_id: str) -> FileResponse:
        if not _VIDEO_ID_RE.match(video_id) or settings.videos_dir is None:
            raise HTTPException(status_code=400, detail="invalid video_id")
        # _VIDEO_ID_RE already forbids "/", ".", ".." in video_id, so this
        # join can never escape videos_dir ?????????????????? no extra containment check is
        # needed. A prior version additionally required the *resolved*
        # (symlink-followed) path to stay under videos_dir, which broke
        # every real video here: data/videos/batch1/*.mp4 are symlinks to
        # /mlcv1/Datasets/HCMAI25/full/*.mp4 by design, so resolving always
        # landed outside videos_dir and every request 404'd.
        video_path = settings.videos_dir / f"{video_id}.mp4"
        if not video_path.exists():
            raise HTTPException(status_code=404, detail="video not found")
        # FileResponse honors Range headers, so <video> scrubbing works
        # without needing HLS segmentation for these single-file mp4s.
        return FileResponse(video_path, media_type="video/mp4")

    @app.get("/api/videos/{video_id}/asr")
    def get_video_asr(
        video_id: str,
        engine: SearchEngine = Depends(get_search_engine),
    ) -> List[Dict[str, Any]]:
        if not _VIDEO_ID_RE.match(video_id):
            raise HTTPException(status_code=400, detail="invalid video_id")
        
        segments = engine._rm.load_asr_bge_segments()
        if not segments:
            return []
            
        video_segments = [s for s in segments if s.get("video_id") == video_id]
        # Sort chronologically just in case
        video_segments.sort(key=lambda s: s.get("start", 0))
        return video_segments

    @app.get("/api/videos/{video_id}/hls/playlist.m3u8")
    def get_video_hls_playlist(video_id: str) -> FileResponse:
        if (
            not _VIDEO_ID_RE.match(video_id)
            or settings.videos_dir is None
            or settings.hls_cache_dir is None
        ):
            raise HTTPException(status_code=400, detail="invalid video_id")
        video_path = settings.videos_dir / f"{video_id}.mp4"
        if not video_path.exists():
            raise HTTPException(status_code=404, detail="video not found")
        try:
            playlist_path = hls_service.ensure_playlist(
                video_id, video_path, settings.hls_cache_dir, settings.hls_segment_seconds
            )
        except RuntimeError as exc:
            logger.error("HLS packaging failed for {}: {}", video_id, exc)
            raise HTTPException(status_code=500, detail="hls packaging failed")
        return FileResponse(playlist_path, media_type="application/vnd.apple.mpegurl")

    @app.get("/api/videos/{video_id}/hls/{segment}")
    def get_video_hls_segment(video_id: str, segment: str) -> FileResponse:
        if (
            not _VIDEO_ID_RE.match(video_id)
            or settings.hls_cache_dir is None
            or not hls_service.is_valid_segment_name(segment)
        ):
            raise HTTPException(status_code=400, detail="invalid request")
        segment_path = settings.hls_cache_dir / video_id / segment
        if not segment_path.exists():
            raise HTTPException(status_code=404, detail="segment not found")
        return FileResponse(segment_path, media_type="video/mp2t")

    @app.get("/api/video-fps")
    def get_video_fps(engine: SearchEngine = Depends(get_search_engine)) -> Dict[str, Any]:
        """Return {default_fps, overrides: {video_id: fps}} for ms<->frame conversion."""
        video_meta = engine._rm.load_video_metadata()
        default_fps = 25.0
        overrides = {}
        for vid, meta in video_meta.items():
            fps = float(meta.get("fps", 25.0))
            if fps != 25.0:
                overrides[vid] = fps
        return {"default_fps": default_fps, "overrides": overrides}


    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "backend.app:app",
        host=settings.host,
        port=settings.port,
        workers=settings.api_workers,
        log_level=settings.log_level.lower(),
    )
