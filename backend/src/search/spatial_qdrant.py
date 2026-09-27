"""Feature-gated BEiT-3 regional retrieval backed by local Qdrant.

This is an optional fourth visual lane. It never replaces the existing
full-frame FAISS PE-Core, BEiT-3, or SigLIP2 lanes. The caller enables it
only for an explicit image-relative spatial request.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
import os
import re
import sys
import threading
import unicodedata
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from loguru import logger


SPATIAL_REGION_VECTORS: Dict[str, Tuple[str, ...]] = {
    "left": ("left",),
    "right": ("right",),
    "top": ("top",),
    "bottom": ("bottom",),
    "top_left": ("left", "top"),
    "top_right": ("right", "top"),
    "bottom_left": ("left", "bottom"),
    "bottom_right": ("right", "bottom"),
}


@dataclass(frozen=True)
class SpatialQuery:
    """A query with an image-relative spatial requirement, if any."""

    semantic_query: str
    spatial_region: str = "full"
    confidence: float = 0.0
    source: str = "none"


@dataclass
class SpatialHit:
    """A point returned from one or more Qdrant regional vector fields."""

    video_id: str
    frame_id: int
    score: float
    rank: int
    matched_axes: Tuple[str, ...] = ()
    axis_scores: Dict[str, float] = field(default_factory=dict)


def _fold_for_match(value: str) -> str:
    """Case-fold Vietnamese/English to ASCII while preserving normal offsets."""
    text = unicodedata.normalize("NFD", str(value or "").casefold())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return text.replace("đ", "d")


# Corners must precede edges. All patterns intentionally use the folded ASCII
# representation from _fold_for_match.
_SPATIAL_PATTERNS: Tuple[Tuple[str, re.Pattern[str]], ...] = (
    (
        "top_left",
        re.compile(
            r"\b(?:goc\s*(?:tren|top|upper)\s*(?:ben\s*)?(?:trai|left)"
            r"|(?:top|upper)[\s-]*(?:left|trai)"
            r"|(?:left|trai)[\s-]*(?:top|upper|tren))\b"
        ),
    ),
    (
        "top_right",
        re.compile(
            r"\b(?:goc\s*(?:tren|top|upper)\s*(?:ben\s*)?(?:phai|right)"
            r"|(?:top|upper)[\s-]*(?:right|phai)"
            r"|(?:right|phai)[\s-]*(?:top|upper|tren))\b"
        ),
    ),
    (
        "bottom_left",
        re.compile(
            r"\b(?:goc\s*(?:duoi|bottom|lower)\s*(?:ben\s*)?(?:trai|left)"
            r"|(?:bottom|lower)[\s-]*(?:left|trai)"
            r"|(?:left|trai)[\s-]*(?:bottom|lower|duoi))\b"
        ),
    ),
    (
        "bottom_right",
        re.compile(
            r"\b(?:goc\s*(?:duoi|bottom|lower)\s*(?:ben\s*)?(?:phai|right)"
            r"|(?:bottom|lower)[\s-]*(?:right|phai)"
            r"|(?:right|phai)[\s-]*(?:bottom|lower|duoi))\b"
        ),
    ),
    (
        "left",
        re.compile(
            r"\b(?:(?:ben|phia)\s+(?:trai|left)"
            r"|(?:on|at|to)\s+(?:the\s+)?left"
            r"|left\s+(?:side|corner|of\s+(?:the\s+)?(?:frame|screen|image)))\b"
        ),
    ),
    (
        "right",
        re.compile(
            r"\b(?:(?:ben|phia)\s+(?:phai|right)"
            r"|(?:on|at|to)\s+(?:the\s+)?right"
            r"|right\s+(?:side|corner|of\s+(?:the\s+)?(?:frame|screen|image)))\b"
        ),
    ),
    (
        "top",
        re.compile(
            r"\b(?:(?:phia\s+)?(?:tren|top|upper)\s+"
            r"(?:khung\s*hinh|man\s*hinh|frame|screen|image)"
            r"|(?:at|on)\s+(?:the\s+)?top)\b"
        ),
    ),
    (
        "bottom",
        re.compile(
            r"\b(?:(?:phia\s+)?(?:duoi|bottom|lower)\s+"
            r"(?:khung\s*hinh|man\s*hinh|frame|screen|image)"
            r"|(?:at|on)\s+(?:the\s+)?bottom)\b"
        ),
    ),
)


def infer_spatial_query(
    query: Optional[str], requested_region: str = "auto"
) -> SpatialQuery:
    """Detect an absolute frame region and return a semantic-only query.

    Object-relative relations such as ben trai cua nguoi or left of a person
    deliberately remain on the full-frame path: regional crops cannot
    represent that relation safely.
    """
    text = " ".join(str(query or "").split())
    if not text:
        return SpatialQuery(semantic_query=text)

    requested = str(requested_region or "auto").strip().lower()
    if requested not in ("", "auto", "full"):
        if requested in SPATIAL_REGION_VECTORS:
            return SpatialQuery(
                semantic_query=text,
                spatial_region=requested,
                confidence=1.0,
                source="explicit",
            )
        logger.warning("Ignoring unsupported explicit spatial region: {}", requested)

    folded = _fold_for_match(text)
    for region, pattern in _SPATIAL_PATTERNS:
        match = pattern.search(folded)
        if match is None:
            continue
        tail = folded[match.end():]
        stripped_tail = tail.lstrip(" ,.;:-")
        leading_tail = len(tail) - len(stripped_tail)
        following = stripped_tail
        # "top-left of the frame" and "goc tren ben trai cua khung
        # hinh" are absolute crop phrases.  Only an object relation such as
        # "left of a person" must stay on the full-frame branch.
        follows_container = re.match(
            r"^(?:cua\s+(?:khung\s*hinh|man\s*hinh|frame|screen|image)\b"
            r"|of\s+(?:the\s+)?(?:frame|screen|image)\b)",
            following,
        )
        if re.match(r"^(?:cua|of)\b", following) and not follows_container:
            continue
        remove_end = match.end()
        if follows_container is not None:
            remove_end += leading_tail + follows_container.end()
        semantic = " ".join(
            (text[:match.start()] + " " + text[remove_end:]).split()
        )
        return SpatialQuery(
            semantic_query=semantic or text,
            spatial_region=region,
            confidence=0.96 if len(SPATIAL_REGION_VECTORS[region]) == 2 else 0.92,
            source="rule",
        )
    return SpatialQuery(semantic_query=text)


class SpatialQdrantSearcher:
    """Lazy Qdrant client with deterministic equal-axis RRF for corners."""

    def __init__(
        self,
        *,
        host: str,
        rest_port: int,
        grpc_port: int,
        collection: str,
        timeout_seconds: float,
        rrf_k: int,
        vendor_path: Optional[str] = None,
    ) -> None:
        self._host = str(host)
        self._rest_port = int(rest_port)
        self._grpc_port = int(grpc_port)
        self._collection = str(collection)
        self._timeout_seconds = float(timeout_seconds)
        self._rrf_k = max(1, int(rrf_k))
        self._vendor_path = vendor_path or os.environ.get(
            "QDRANT_CLIENT_VENDOR_PATH",
            "/home/bachdx/Final_AIC/backend/vendor/python",
        )
        self._client = None
        self._lock = threading.Lock()

    def _get_client(self):
        if self._client is not None:
            return self._client
        with self._lock:
            if self._client is not None:
                return self._client
            if self._vendor_path and os.path.isdir(self._vendor_path):
                if self._vendor_path not in sys.path:
                    sys.path.insert(0, self._vendor_path)
            from qdrant_client import QdrantClient  # type: ignore

            self._client = QdrantClient(
                host=self._host,
                port=self._rest_port,
                grpc_port=self._grpc_port,
                prefer_grpc=True,
                timeout=self._timeout_seconds,
            )
        return self._client

    def _query_axis(
        self, vector: np.ndarray, axis: str, limit: int
    ) -> Sequence[object]:
        response = self._get_client().query_points(
            collection_name=self._collection,
            query=vector.tolist(),
            using=axis,
            limit=int(limit),
            with_payload=True,
            with_vectors=False,
        )
        return list(getattr(response, "points", ()))

    def search(
        self,
        query_vector: np.ndarray,
        spatial_region: str,
        *,
        limit: int,
        per_axis_limit: int,
    ) -> List[SpatialHit]:
        """Search one edge, or fuse two corner axes with equal-weight RRF."""
        axes = SPATIAL_REGION_VECTORS.get(str(spatial_region or "full"))
        if not axes or int(limit) <= 0:
            return []
        vector = np.asarray(query_vector, dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(vector))
        if not np.isfinite(norm) or norm <= 0.0:
            logger.warning("Spatial Qdrant skipped an invalid BEiT-3 query vector")
            return []
        vector = vector / norm

        try:
            if len(axes) == 1:
                axis_results = [(axes[0], self._query_axis(
                    vector, axes[0], per_axis_limit
                ))]
            else:
                axis_results = []
                with ThreadPoolExecutor(
                    max_workers=len(axes), thread_name_prefix="spatial_qdrant"
                ) as pool:
                    futures = {
                        pool.submit(self._query_axis, vector, axis, per_axis_limit): axis
                        for axis in axes
                    }
                    for future in as_completed(futures):
                        axis_results.append((futures[future], future.result()))
        except Exception as exc:  # feature must fail open to FAISS
            logger.warning("Spatial Qdrant retrieval unavailable: {}", exc)
            return []

        merged: Dict[Tuple[str, int], Dict[str, object]] = {}
        axis_weight = 1.0 / len(axis_results)
        for axis, points in axis_results:
            for rank, point in enumerate(points, start=1):
                payload = getattr(point, "payload", None) or {}
                video_id = str(payload.get("video_id", ""))
                try:
                    frame_id = int(payload.get("frame_id"))
                except (TypeError, ValueError):
                    continue
                if not video_id:
                    continue
                key = (video_id, frame_id)
                record = merged.setdefault(
                    key, {"rrf": 0.0, "axis_scores": {}, "axes": set()}
                )
                record["rrf"] = float(record["rrf"]) + axis_weight / (
                    self._rrf_k + rank
                )
                axis_scores = record["axis_scores"]
                assert isinstance(axis_scores, dict)
                axis_scores[axis] = float(getattr(point, "score", 0.0))
                axes_seen = record["axes"]
                assert isinstance(axes_seen, set)
                axes_seen.add(axis)

        ordered = sorted(
            merged.items(),
            key=lambda item: (
                -float(item[1]["rrf"]),
                -len(item[1]["axes"]),
                -max(item[1]["axis_scores"].values()),
                item[0][0],
                item[0][1],
            ),
        )[: int(limit)]
        output: List[SpatialHit] = []
        for rank, ((video_id, frame_id), record) in enumerate(ordered, start=1):
            output.append(
                SpatialHit(
                    video_id=video_id,
                    frame_id=frame_id,
                    score=float(record["rrf"]),
                    rank=rank,
                    matched_axes=tuple(sorted(record["axes"])),
                    axis_scores=dict(record["axis_scores"]),
                )
            )
        return output
