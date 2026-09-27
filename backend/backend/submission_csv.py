"""CSV submission backend for the competition website.

Implements:
  POST /submission/csv   - write one row to a per-query CSV
  GET  /submission/queries - load query catalog with current answer counts

Based on nghiadq's serve_frontend.py submission system, adapted for the
FastAPI backend.  Queries live under QUERY_ROOT (configured via env), answer
CSVs live under CSV_SUBMISSION_ROOT.
"""
from __future__ import annotations

import csv
import fcntl
import re
import threading
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.config import get_settings

router = APIRouter(prefix="/submission", tags=["submission"])

_LOCK = threading.Lock()

# ── Config ──────────────────────────────────────────────────────────────────

def _get_roots() -> tuple[Path, Path]:
    settings = get_settings()
    repo_root = Path(__file__).resolve().parent.parent
    query_root = repo_root / "query_demo"
    csv_root = repo_root / "submission"
    return query_root, csv_root

# ── Filename parsing ────────────────────────────────────────────────────────

QUERY_RE = re.compile(r"^query-(.+)-((?:kis|qa|trake))\.txt$", re.IGNORECASE)
EVENT_RE = re.compile(r"^\s*E\d+\s*:", re.IGNORECASE | re.MULTILINE)


def parse_query_filename(name: str) -> tuple[str, str]:
    """Return (label, task_type) from a query filename like 'query-1-kis.txt'."""
    m = QUERY_RE.match(name)
    if not m:
        raise ValueError(f"invalid query filename: {name!r}")
    return m.group(1), m.group(2).lower()


def _query_sort_key(filename: str) -> List[tuple[int, Any]]:
    return [
        (0, int(p)) if p.isdigit() else (1, p.lower())
        for p in re.split(r"(\d+)", filename)
        if p
    ]


def _row_count(path: Path) -> int:
    if not path.is_file():
        return 0
    with path.open("r", encoding="utf-8") as f:
        return sum(1 for row in csv.reader(f) if row)


def _load_catalog(query_root: Path, csv_root: Path) -> List[Dict[str, Any]]:
    if not query_root.is_dir():
        return []
    queries = []
    for path in sorted(query_root.iterdir(), key=lambda p: _query_sort_key(p.name)):
        if not path.is_file():
            continue
        try:
            label, task_type = parse_query_filename(path.name)
        except ValueError:
            continue
        output_path = csv_root / f"{path.stem}.csv"
        queries.append({
            "filename": path.name,
            "label": label,
            "task_type": task_type,
            "content": path.read_text(encoding="utf-8").strip(),
            "answer_count": _row_count(output_path),
            "output_filename": output_path.name,
        })
    return queries


# ── Row builder ─────────────────────────────────────────────────────────────

class _SubmitItem(BaseModel):
    video_id: str
    frame_id: int


class _SubmitRequest(BaseModel):
    query_filename: str
    items: List[_SubmitItem]
    answer: str = ""


def _build_row(
    query_path: Path,
    task_type: str,
    items: List[Dict[str, Any]],
    answer: str = "",
) -> List[Any]:
    normalized = []
    for item in items:
        # Support both dict (JSON) and Pydantic model (validated request body)
        if hasattr(item, "video_id"):
            video_id = str(item.video_id).strip()
            raw_frame = getattr(item, "frame_id", None) or getattr(item, "frame_idx", None)
        else:
            video_id = str(item.get("video_id", "")).strip()
            raw_frame = item.get("frame_id", item.get("frame_idx"))
        if not video_id or video_id.lower().endswith(".mp4") or "," in video_id:
            raise ValueError("invalid video_id")
        try:
            frame_id = int(raw_frame)
        except (TypeError, ValueError):
            raise ValueError("frame_id must be an integer")
        if frame_id < 0:
            raise ValueError("frame_id must be non-negative")
        normalized.append((video_id, frame_id))

    if task_type == "kis":
        if len(normalized) != 1:
            raise ValueError("KIS takes exactly one frame per row")
        return [normalized[0][0], normalized[0][1]]

    if task_type == "qa":
        if len(normalized) != 1:
            raise ValueError("QA takes exactly one frame per row")
        answer_text = str(answer)
        if not answer_text.strip():
            raise ValueError("QA answer must be non-empty")
        if len(answer_text) > 100:
            raise ValueError("QA answer must be 100 chars or fewer")
        return [normalized[0][0], normalized[0][1], answer_text]

    if task_type == "trake":
        video_id = normalized[0][0]
        if any(vid != video_id for vid, _ in normalized):
            raise ValueError("TRAKE frames must belong to the same video")
        # Count events from query content to validate frame count
        event_count = len(EVENT_RE.findall(query_path.read_text(encoding="utf-8")))
        if event_count and len(normalized) != event_count:
            raise ValueError(
                f"TRAKE requires exactly {event_count} frames matching query events, got {len(normalized)}"
            )
        return [video_id, *(fid for _, fid in normalized)]

    raise ValueError(f"unknown task type: {task_type!r}")


# ── Routes ─────────────────────────────────────────────────────────────────

@router.get("/queries")
async def get_queries() -> JSONResponse:
    """Return the full query catalog with current answer counts."""
    query_root, csv_root = _get_roots()
    queries = _load_catalog(query_root, csv_root)
    return JSONResponse({"queries": queries})


@router.post("/csv")
async def submit_csv(body: _SubmitRequest) -> JSONResponse:
    """Append one row to the per-query CSV.

    Request body::

        {
          "query_filename": "query-1-kis.txt",
          "items": [{"video_id": "L01_V028", "frame_id": 25300}],
          "answer": "..."   // QA only
        }

    Response::

        {
          "output_filename": "query-1-kis.csv",
          "answer_count": 3,
          "row": [...]
        }
    """
    query_root, csv_root = _get_roots()

    filename = body.query_filename.strip()
    try:
        _, task_type = parse_query_filename(filename)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    query_path = query_root / filename
    if not query_path.is_file():
        raise HTTPException(404, f"query {filename!r} not found")

    try:
        row = _build_row(query_path, task_type, body.items, body.answer)
    except ValueError as exc:
        raise HTTPException(400, f"invalid submission row: {exc}")

    csv_root.mkdir(parents=True, exist_ok=True)
    output_path = csv_root / f"{query_path.stem}.csv"

    lock_path = csv_root / ".submission.lock"
    with _LOCK:
        with lock_path.open("a+") as lf:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            count = _row_count(output_path)
            if count >= 100:
                fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
                raise HTTPException(409, "CSV has reached the 100-row limit")
            with output_path.open("a", encoding="utf-8", newline="") as f:
                csv.writer(f, lineterminator="\n").writerow(row)
            count += 1
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)

    return JSONResponse({
        "query_filename": filename,
        "output_filename": output_path.name,
        "answer_count": count,
        "row": row,
    })


# ── SOLOAI ────────────────────────────────────────────────────────────────────
SOLOAI_ROOT = Path("/home/bachdx/SOLOAI")


class _SoloSubmitRequest(BaseModel):
    query_filename: str
    items: List[_SubmitItem]
    answer: str = ""


@router.post("/solo")
async def submit_solo(body: _SoloSubmitRequest) -> JSONResponse:
    filename = body.query_filename.strip()
    try:
        _, task_type = parse_query_filename(filename)
    except ValueError:
        task_type = "kis"

    csv_name = Path(filename).stem + ".csv"
    SOLOAI_ROOT.mkdir(parents=True, exist_ok=True)
    output_path = SOLOAI_ROOT / csv_name

    dummy_path = None
    query_dir, _ = _get_roots()
    if (query_dir / filename).exists():
        dummy_path = query_dir / filename

    try:
        row = _build_row(dummy_path, task_type, body.items, body.answer)
    except ValueError as exc:
        raise HTTPException(400, f"invalid row: {exc}")

    with _LOCK:
        with output_path.open("a", encoding="utf-8", newline="") as f:
            csv.writer(f, lineterminator="").writerow(row)

    return JSONResponse({
        "output_filename": csv_name,
        "saved_path": str(output_path),
        "row": row,
    })
