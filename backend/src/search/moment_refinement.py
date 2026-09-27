"""Moment refinement: the "conquer" stage of delegate-and-conquer search.

DeCafNet (Lu et al., CVPR 2025) grounds moments in long videos by first
running a cheap "sidekick" pass to build a saliency map over the whole
video, then a heavier "expert" pass ONLY inside the salient regions, and
finally reconciling the two into a precise boundary. This module is the
expert/refinement stage for our pipeline, built on the pieces we already
have:

- The cheap sidekick + saliency map is ``search_hierarchical`` (Part 1):
  flat RRF search grouped into a video -> segment -> keyframe tree, where a
  segment's aggregate score is exactly a saliency signal for "which region
  deserves a closer look".
- The expert/refinement here takes each salient segment — already a coarse
  activity boundary (from time-window or kernel change-point event
  segmentation) — and tightens it to the precise ``[start, end)`` moment
  around the query-relevant peak, using neighbor score aggregation
  (Algorithm 2 of arXiv:2504.08384) as the query-aware temporal aggregator.

No new model, no GPU: the keyframe scores are the RRF-fused, query-
conditioned scores the tree already carries.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Sequence, Tuple

FpsLookup = Callable[[str], float]

DEFAULT_WINDOW_SECONDS = 5.0
DEFAULT_RELATIVE_THRESHOLD = 0.5


@dataclass(frozen=True)
class RefinedMoment:
    """A tightened ``[start_frame, end_frame)`` moment inside one video.

    ``end_frame`` is exclusive, following the pipeline's
    ``[start_frame, end_frame)`` convention; for keyframe-sampled data it is
    the rightmost qualifying keyframe id plus one, so a single-keyframe
    moment is ``[peak, peak + 1)``.
    """

    video_id: str
    start_frame: int
    end_frame: int
    peak_frame: int
    score: float

    @property
    def window_id(self) -> str:
        """Deterministic id from integer frame bounds (never from seconds).

        Used to correlate this moment across separate GPU pipelines (e.g. a
        UniversalVTG pre-extraction pass over the same window — see
        src/search/moment_fusion.py) without float-rounding desync.
        """
        return f"{self.video_id}::{self.start_frame}-{self.end_frame}"


def _aggregate_within_segment(
    frames: Sequence[Tuple[int, float]],
    fps: float,
    window_seconds: float,
) -> List[Tuple[int, float]]:
    """Sum each frame's score with its same-segment temporal neighbors.

    Query-aware temporal aggregation: the input scores are already
    query-conditioned, so a frame flanked by other query-relevant frames
    accumulates a higher total. Mirrors ``neighbor_score_aggregation`` but
    inlined for a single video/segment where fps is one scalar.
    """
    aggregated: List[Tuple[int, float]] = []
    for center_frame, center_score in frames:
        total = center_score
        for other_frame, other_score in frames:
            if other_frame == center_frame:
                continue
            if abs(other_frame - center_frame) / fps <= window_seconds:
                total += other_score
        aggregated.append((center_frame, total))
    return aggregated


def refine_moment_within_segment(
    frames: Sequence[Tuple[int, float]],
    video_id: str,
    *,
    fps: float,
    window_seconds: float = DEFAULT_WINDOW_SECONDS,
    relative_threshold: float = DEFAULT_RELATIVE_THRESHOLD,
) -> RefinedMoment:
    """Tighten one segment's keyframes to the moment around the peak.

    Aggregates each keyframe's score with its neighbors, finds the peak
    keyframe, then expands outward while the aggregated score stays at or
    above ``relative_threshold * peak`` — a watershed around the peak, the
    standard way temporal-localization methods turn a score profile into a
    boundary. The moment score is the peak's aggregated score.

    ``frames`` are ``(frame_id, score)`` for keyframes of ONE video; they
    need not be pre-sorted. Raises ``ValueError`` if empty.
    """
    if not frames:
        raise ValueError("frames must be non-empty")
    if fps <= 0:
        raise ValueError(f"fps must be positive, got {fps}")
    if not 0.0 <= relative_threshold <= 1.0:
        raise ValueError("relative_threshold must be in [0, 1]")
    if window_seconds <= 0:
        raise ValueError("window_seconds must be positive")

    ordered = sorted(frames, key=lambda item: item[0])
    aggregated = _aggregate_within_segment(ordered, fps, window_seconds)

    peak_index = max(range(len(aggregated)), key=lambda i: aggregated[i][1])
    peak_frame, peak_score = aggregated[peak_index]
    cutoff = peak_score * relative_threshold

    left = peak_index
    while left - 1 >= 0 and aggregated[left - 1][1] >= cutoff:
        left -= 1
    right = peak_index
    while right + 1 < len(aggregated) and aggregated[right + 1][1] >= cutoff:
        right += 1

    start_frame = aggregated[left][0]
    end_frame = aggregated[right][0] + 1  # exclusive, half-open
    return RefinedMoment(
        video_id=video_id,
        start_frame=start_frame,
        end_frame=end_frame,
        peak_frame=peak_frame,
        score=peak_score,
    )


def refine_moments_from_hierarchy(
    video_nodes: Sequence["object"],
    *,
    fps_lookup: FpsLookup,
    window_seconds: float = DEFAULT_WINDOW_SECONDS,
    relative_threshold: float = DEFAULT_RELATIVE_THRESHOLD,
    top_k: int | None = None,
) -> List[RefinedMoment]:
    """Refine every segment of a hierarchy into a ranked list of moments.

    ``video_nodes`` is the output of
    ``src.search.hierarchical_search.build_hierarchy`` (the delegate stage's
    saliency tree). Each segment — already narrowed to the salient ones by
    the tree's ``top_k_segments_per_video`` — becomes one refined moment.
    Moments are ranked by refined score (deterministic tie-break by video
    then start frame) and truncated to ``top_k`` when given.
    """
    moments: List[RefinedMoment] = []
    for video_node in video_nodes:
        fps = fps_lookup(video_node.video_id)
        for segment in video_node.segments:
            frames = [(kf.frame_id, kf.score) for kf in segment.keyframes]
            if not frames:
                continue
            moments.append(
                refine_moment_within_segment(
                    frames,
                    video_node.video_id,
                    fps=fps,
                    window_seconds=window_seconds,
                    relative_threshold=relative_threshold,
                )
            )

    moments.sort(key=lambda m: (-m.score, m.video_id, m.start_frame))
    if top_k is not None:
        moments = moments[:top_k]
    return moments


__all__ = [
    "DEFAULT_RELATIVE_THRESHOLD",
    "DEFAULT_WINDOW_SECONDS",
    "RefinedMoment",
    "refine_moment_within_segment",
    "refine_moments_from_hierarchy",
]
