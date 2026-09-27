"""Hierarchical video -> segment -> keyframe index for narrowing search.

Retrieval signals from any modality (visual/OCR/audio, or the RRF-fused
result of ``HybridSearchEngine.search``) are flat lists of
``(video_id, frame_id, score)``. This module groups them into a 3-tier tree
so a UI or a downstream reranker can narrow to the top videos, then the top
segments within those videos, then the top keyframes within those segments
— instead of scanning every keyframe in the corpus at once.

There is no real scene-boundary index yet: TransNetV2 scene detection is
blocked pending a weight conversion (see docs/SERVER_HANDOVER_CODEX.md). The
segment tier defaults to fixed time-window bucketing so hierarchical search
works today; swap in real scene ids later by passing a different
``segment_key_fn`` of the same shape — the tree-building logic does not
change.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

FpsLookup = Callable[[str], float]
SegmentKeyFn = Callable[[str, int, FpsLookup], str]


def _max_aggregate(scores: Sequence[float]) -> float:
    return max(scores)


def _sum_aggregate(scores: Sequence[float]) -> float:
    return sum(scores)


_AGGREGATORS: Dict[str, Callable[[Sequence[float]], float]] = {
    "max": _max_aggregate,
    "sum": _sum_aggregate,
}


@dataclass
class KeyframeHit:
    """A single leaf hit."""

    video_id: str
    frame_id: int
    score: float


@dataclass
class SegmentNode:
    """A group of nearby keyframes (a scene, or a time-window placeholder)."""

    segment_id: str
    video_id: str
    score: float
    keyframes: List[KeyframeHit] = field(default_factory=list)


@dataclass
class VideoNode:
    """A video, ranked by its best-matching segment."""

    video_id: str
    score: float
    segments: List[SegmentNode] = field(default_factory=list)


def time_window_segment_key(
    video_id: str,
    frame_id: int,
    fps_lookup: FpsLookup,
    *,
    window_seconds: float = 5.0,
) -> str:
    """Default segment grouping: fixed time buckets within a video.

    A placeholder for real scene boundaries. Deterministic given the same
    fps, so callers can treat the returned id like a scene id.
    """
    if window_seconds <= 0:
        raise ValueError("window_seconds must be positive")
    fps = fps_lookup(video_id)
    if fps <= 0:
        raise ValueError(f"fps must be positive, got {fps} for video {video_id!r}")
    bucket = int((frame_id / fps) // window_seconds)
    return f"{video_id}::seg{bucket}"


def build_hierarchy(
    hits: Sequence[Tuple[str, int, float]],
    *,
    fps_lookup: FpsLookup,
    segment_key_fn: Optional[SegmentKeyFn] = None,
    top_k_videos: Optional[int] = None,
    top_k_segments_per_video: Optional[int] = None,
    top_k_frames_per_segment: Optional[int] = None,
    video_agg: str = "max",
    segment_agg: str = "max",
) -> List[VideoNode]:
    """Group flat ``(video_id, frame_id, score)`` hits into a 3-tier tree.

    Each tier's score is an aggregate of its children (``video_agg`` /
    ``segment_agg``, default "max": a video/segment is as relevant as its
    best frame), sorted descending with id as a deterministic tie-break.
    ``top_k_*`` truncate each tier after sorting, applied top-down — top
    videos first, then top segments within those, then top frames within
    those — so aggregates reflect only the kept children, matching how a
    drill-down UI or reranker would actually narrow the search.
    """
    if not hits:
        return []
    if video_agg not in _AGGREGATORS:
        raise ValueError(f"unknown video_agg={video_agg!r}")
    if segment_agg not in _AGGREGATORS:
        raise ValueError(f"unknown segment_agg={segment_agg!r}")
    key_fn = segment_key_fn or time_window_segment_key

    by_video: Dict[str, List[Tuple[str, int, float]]] = {}
    for video_id, frame_id, score in hits:
        by_video.setdefault(video_id, []).append((video_id, frame_id, score))

    video_nodes: List[VideoNode] = []
    for video_id, video_hits in by_video.items():
        by_segment: Dict[str, List[KeyframeHit]] = {}
        for v_id, frame_id, score in video_hits:
            segment_id = key_fn(v_id, frame_id, fps_lookup)
            by_segment.setdefault(segment_id, []).append(
                KeyframeHit(v_id, frame_id, score)
            )

        segment_nodes: List[SegmentNode] = []
        for segment_id, keyframes in by_segment.items():
            keyframes.sort(key=lambda kf: (-kf.score, kf.frame_id))
            if top_k_frames_per_segment is not None:
                keyframes = keyframes[:top_k_frames_per_segment]
            seg_score = _AGGREGATORS[segment_agg]([kf.score for kf in keyframes])
            segment_nodes.append(SegmentNode(segment_id, video_id, seg_score, keyframes))

        segment_nodes.sort(key=lambda seg: (-seg.score, seg.segment_id))
        if top_k_segments_per_video is not None:
            segment_nodes = segment_nodes[:top_k_segments_per_video]

        vid_score = _AGGREGATORS[video_agg]([seg.score for seg in segment_nodes])
        video_nodes.append(VideoNode(video_id, vid_score, segment_nodes))

    video_nodes.sort(key=lambda v: (-v.score, v.video_id))
    if top_k_videos is not None:
        video_nodes = video_nodes[:top_k_videos]
    return video_nodes


__all__ = [
    "KeyframeHit",
    "SegmentNode",
    "VideoNode",
    "build_hierarchy",
    "time_window_segment_key",
]
