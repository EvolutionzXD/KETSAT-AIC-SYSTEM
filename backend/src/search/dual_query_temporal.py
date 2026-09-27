"""Dual-query temporal search and neighbor-context reranking.

Two lightweight moment-retrieval techniques from "Towards Efficient and
Robust Moment Retrieval System" (Tran et al., CVPRW 2025, arXiv:2504.08384),
implemented over the frame embeddings the pipeline ALREADY has — no new
model, no GPU:

- ``dual_query_temporal_search``: the user describes the segment start and
  the segment end as two separate queries; frame-level hits for each are
  paired inside one video into scored ``[start, end)`` segments. This is
  the cheap baseline that heavier grounders (UniversalVTG, HieraMamba)
  must beat to justify their cost.
- ``rerank_with_neighbor_context``: a frame whose temporal neighbors also
  match the query is more trustworthy than an isolated spike; blending the
  mean neighbor score stabilizes single-query rankings.

All time windows are seconds converted with each video's REAL fps.
"""
import math
from dataclasses import dataclass
from typing import Callable, List, Sequence, Tuple

# (video_id, original_frame_idx, score) — rank-ordered retrieval hits.
FrameHit = Tuple[str, int, float]

FpsLookup = Callable[[str], float]


@dataclass(frozen=True)
class TemporalSegmentCandidate:
    """A scored ``[start_frame, end_frame)`` segment inside one video."""

    video_id: str
    start_frame: int
    end_frame: int
    start_score: float
    end_score: float
    score: float


def _validate_hits(hits: Sequence[FrameHit], name: str) -> None:
    for video_id, frame, score in hits:
        if not video_id:
            raise ValueError(f"{name}: video_id must be non-empty")
        if frame < 0:
            raise ValueError(f"{name}: frame index must be non-negative")
        if not math.isfinite(score):
            raise ValueError(f"{name}: score must be finite")


def dual_query_temporal_search(
    start_hits: Sequence[FrameHit],
    end_hits: Sequence[FrameHit],
    *,
    fps_lookup: FpsLookup,
    max_duration_seconds: float = 120.0,
    min_duration_seconds: float = 0.0,
    max_frames_per_query: int = 20,
    top_k: int = 10,
) -> List[TemporalSegmentCandidate]:
    """Pair start-query and end-query frame hits into scored segments.

    Realizes Algorithm 4 of arXiv:2504.08384 (Temporal Frame Pair Selection):
    each query keeps its top ``max_frames_per_query`` relevant frames (the
    paper's "extend until 20 relevant frames"), and the best pair maximizing
    combined start+end similarity is selected under a gap constraint — here the
    ``[min_duration_seconds, max_duration_seconds]`` window (the paper's gapC).

    A pair qualifies when both hits are in the same video, the end frame is
    strictly after the start frame, and the duration (via the video's real
    fps) is within the gap window. Segment score is the sum of both hit
    scores. Results are sorted by score with a deterministic tie-break.
    """
    if top_k <= 0:
        raise ValueError("top_k must be positive")
    if max_frames_per_query <= 0:
        raise ValueError("max_frames_per_query must be positive")
    if max_duration_seconds <= 0 or not math.isfinite(max_duration_seconds):
        raise ValueError("max_duration_seconds must be finite and positive")
    if min_duration_seconds < 0 or min_duration_seconds >= max_duration_seconds:
        raise ValueError(
            "min_duration_seconds must be >= 0 and < max_duration_seconds"
        )
    _validate_hits(start_hits, "start_hits")
    _validate_hits(end_hits, "end_hits")

    # Paper's per-query cap of 20 relevant frames: hits arrive rank-ordered,
    # so truncating keeps the most relevant ones.
    start_hits = list(start_hits)[:max_frames_per_query]
    end_hits = list(end_hits)[:max_frames_per_query]

    candidates: List[TemporalSegmentCandidate] = []
    for start_video, start_frame, start_score in start_hits:
        fps = fps_lookup(start_video)
        if fps <= 0:
            raise ValueError(f"fps for video '{start_video}' must be positive")
        for end_video, end_frame, end_score in end_hits:
            if end_video != start_video or end_frame <= start_frame:
                continue
            duration = (end_frame - start_frame) / fps
            if not min_duration_seconds <= duration <= max_duration_seconds:
                continue
            candidates.append(
                TemporalSegmentCandidate(
                    video_id=start_video,
                    start_frame=start_frame,
                    end_frame=end_frame,
                    start_score=start_score,
                    end_score=end_score,
                    score=start_score + end_score,
                )
            )

    candidates.sort(
        key=lambda c: (-c.score, c.video_id, c.start_frame, c.end_frame)
    )
    return candidates[:top_k]


def _neighbor_scores(
    hits: Sequence[FrameHit],
    index: int,
    video_id: str,
    frame: int,
    fps: float,
    window_seconds: float,
) -> List[float]:
    """Scores of OTHER same-video hits within ``window_seconds`` of ``frame``."""
    return [
        other_score
        for other_index, (other_video, other_frame, other_score) in enumerate(hits)
        if other_index != index
        and other_video == video_id
        and abs(other_frame - frame) / fps <= window_seconds
    ]


def neighbor_score_aggregation(
    hits: Sequence[FrameHit],
    *,
    fps_lookup: FpsLookup,
    window_seconds: float = 5.0,
    include_center: bool = True,
) -> List[FrameHit]:
    """Rerank by the SUM of a frame's own and neighbors' scores (Algorithm 2).

    Faithful to arXiv:2504.08384 Algorithm 2 (Neighbor Score Aggregation): a
    frame surrounded by other query-relevant frames accumulates a higher total,
    so temporally consistent regions rise above isolated single-frame spikes.
    Unlike :func:`rerank_with_neighbor_context` (a softer, weighted blend of the
    MEAN), this SUMS raw neighbor scores exactly as the paper specifies.
    """
    if window_seconds <= 0 or not math.isfinite(window_seconds):
        raise ValueError("window_seconds must be finite and positive")
    _validate_hits(hits, "hits")

    reranked: List[FrameHit] = []
    for index, (video_id, frame, score) in enumerate(hits):
        fps = fps_lookup(video_id)
        if fps <= 0:
            raise ValueError(f"fps for video '{video_id}' must be positive")
        neighbors = _neighbor_scores(
            hits, index, video_id, frame, fps, window_seconds
        )
        total = (score if include_center else 0.0) + sum(neighbors)
        reranked.append((video_id, frame, total))

    reranked.sort(key=lambda hit: (-hit[2], hit[0], hit[1]))
    return reranked


def rerank_with_neighbor_context(
    hits: Sequence[FrameHit],
    *,
    fps_lookup: FpsLookup,
    window_seconds: float = 5.0,
    neighbor_weight: float = 0.5,
) -> List[FrameHit]:
    """Blend each hit's score with the mean score of its temporal neighbors.

    A softer variant of :func:`neighbor_score_aggregation`:
    ``new_score = score + neighbor_weight * mean(neighbor scores)`` where
    neighbors are OTHER hits of the same video within ``window_seconds``.
    Isolated hits keep their original score, so the reranking never
    penalizes — it only promotes temporally consistent regions.
    """
    if window_seconds <= 0 or not math.isfinite(window_seconds):
        raise ValueError("window_seconds must be finite and positive")
    if neighbor_weight < 0 or not math.isfinite(neighbor_weight):
        raise ValueError("neighbor_weight must be finite and non-negative")
    _validate_hits(hits, "hits")

    reranked: List[FrameHit] = []
    for index, (video_id, frame, score) in enumerate(hits):
        fps = fps_lookup(video_id)
        if fps <= 0:
            raise ValueError(f"fps for video '{video_id}' must be positive")
        neighbor_scores = _neighbor_scores(
            hits, index, video_id, frame, fps, window_seconds
        )
        context = (
            sum(neighbor_scores) / len(neighbor_scores) if neighbor_scores else 0.0
        )
        reranked.append((video_id, frame, score + neighbor_weight * context))

    reranked.sort(key=lambda hit: (-hit[2], hit[0], hit[1]))
    return reranked
