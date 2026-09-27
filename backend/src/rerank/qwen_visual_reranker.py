"""Deadline-bounded client for a remote Qwen3-VL visual reranker."""
from __future__ import annotations

import base64
import io
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from PIL import Image, ImageDraw, ImageOps

FrameResolver = Callable[[str, int], Optional[Path]]


@dataclass(frozen=True)
class QwenRerankOutcome:
    candidates: List[Dict[str, Any]]
    applied: bool
    latency_ms: float
    reason: str
    service_latency_ms: float = 0.0


class QwenVisualReranker:
    def __init__(self, base_url: str, frame_resolver: FrameResolver, *, image_size: int = 384, jpeg_quality: int = 80) -> None:
        self._url = base_url.rstrip("/") + "/rerank"
        self._resolve = frame_resolver
        self._image_size = image_size
        self._jpeg_quality = jpeg_quality
        self._calls = self._applied = self._fallbacks = 0
        self._latency_total = 0.0

    def _single_frame(self, candidate: Mapping[str, Any]) -> Optional[Image.Image]:
        value = candidate.get("frame_path")
        path = Path(str(value)) if value else self._resolve(str(candidate.get("video_id", "")), int(candidate.get("frame_id", -1)))
        if path is None or not path.exists():
            return None
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((self._image_size, self._image_size), Image.Resampling.LANCZOS)
        return image

    def _sequence_canvas(self, candidate: Mapping[str, Any]) -> Optional[Image.Image]:
        video_id = str(candidate.get("video_id", ""))
        frame_ids = [frame for frame in candidate.get("frame_ids", []) if frame is not None]
        if not frame_ids:
            return None
        cell = self._image_size // 2
        canvas = Image.new("RGB", (self._image_size, self._image_size), "black")
        loaded = 0
        for index, frame_id in enumerate(frame_ids[:4]):
            path = self._resolve(video_id, int(frame_id))
            if path is None or not path.exists():
                continue
            with Image.open(path) as source:
                panel = ImageOps.exif_transpose(source).convert("RGB")
            panel.thumbnail((cell, cell), Image.Resampling.LANCZOS)
            x = (index % 2) * cell + (cell - panel.width) // 2
            y = (index // 2) * cell + (cell - panel.height) // 2
            canvas.paste(panel, (x, y))
            ImageDraw.Draw(canvas).text((x + 4, y + 4), f"E{index + 1}", fill="yellow")
            loaded += 1
        return canvas if loaded else None

    def _encode(self, image: Image.Image) -> str:
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=self._jpeg_quality, optimize=True)
        return base64.b64encode(output.getvalue()).decode("ascii")

    def rerank(self, task: str, query: str, candidates: Sequence[Mapping[str, Any]], *, candidate_limit: int = 15, timeout: float = 20.0) -> QwenRerankOutcome:
        local = [dict(candidate) for candidate in candidates]
        started = time.perf_counter()
        applied, reason, service_latency, ranked = False, "service_error", 0.0, local
        try:
            head = local[:candidate_limit]
            rows, by_id, original_rank = [], {}, {}
            for index, candidate in enumerate(head):
                candidate_id = f"c{index}"
                image = self._sequence_canvas(candidate) if task == "trake" else self._single_frame(candidate)
                if image is None:
                    continue
                rows.append({"id": candidate_id, "image_base64": self._encode(image), "text": str(candidate.get("caption_snippet") or "")[:240]})
                by_id[candidate_id], original_rank[candidate_id] = candidate, index + 1
            if len(rows) < 2:
                raise ValueError("fewer than two readable candidate images")
            import requests
            response = requests.post(self._url, json={"task": task, "query": query, "candidates": rows}, timeout=timeout)
            response.raise_for_status()
            data = response.json()
            service_latency = float(data.get("latency_ms", 0.0) or 0.0)
            scored, seen = [], set()
            for row in data.get("ranking", []):
                candidate_id = str(row.get("id", ""))
                if candidate_id in by_id and candidate_id not in seen:
                    seen.add(candidate_id)
                    scored.append((candidate_id, max(0.0, min(1.0, float(row.get("score", 0.0))))))
            if not scored:
                raise ValueError("service returned no valid ids")
            scored.extend((candidate_id, 0.0) for candidate_id in by_id if candidate_id not in seen)
            ranked_head = []
            for rank, (candidate_id, score) in enumerate(scored, start=1):
                candidate = dict(by_id[candidate_id])
                candidate.update(local_rank=original_rank[candidate_id], qwen_rank=rank, qwen_score=round(score, 4))
                ranked_head.append(candidate)
            used = {(item.get("video_id"), item.get("frame_id"), tuple(item.get("frame_ids", []))) for item in ranked_head}
            ranked_head.extend(candidate for candidate in head if (candidate.get("video_id"), candidate.get("frame_id"), tuple(candidate.get("frame_ids", []))) not in used)
            ranked = ranked_head + local[candidate_limit:]
            applied, reason = True, "applied"
        except Exception as exc:  # noqa: BLE001
            reason = f"fallback:{type(exc).__name__}"
        latency_ms = (time.perf_counter() - started) * 1000.0
        self._calls += 1
        self._applied += int(applied)
        self._fallbacks += int(not applied)
        self._latency_total += latency_ms
        return QwenRerankOutcome(ranked, applied, latency_ms, reason, service_latency)

    def stats(self) -> Dict[str, Any]:
        return {"calls": self._calls, "applied": self._applied, "fallbacks": self._fallbacks, "average_latency_ms": round(self._latency_total / self._calls, 1) if self._calls else 0.0, "url": self._url}
