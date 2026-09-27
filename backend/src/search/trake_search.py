"""TRAKE: align an ordered sequence of event descriptions to one frame each.

The organizer's scoring contract (src/eval/aic2026_preliminary.py::
TRAKEAnswer) fixes the output shape: one video_id plus exactly one frame_id
per semantic moment, judged per-moment against inclusive frame ranges. This
module holds the pure assignment logic — given per-event candidate frames
already retrieved by the hybrid engine, pick for each candidate video the
strictly-increasing frame sequence (one frame per event, in event order)
that maximizes the summed retrieval score. Retrieval itself stays in
SearchEngine.search_trake; everything here is deterministic and testable
without models or indexes.

The per-video optimization is a standard longest-chain DP over events:
process events in order, and for each candidate frame of event i take the
best-scoring prefix among event i-1 candidates at strictly earlier frames
(prefix-max over frame-sorted candidates, so each event pair costs
O(C log C) for sorting rather than O(C^2)).
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Dict, List, Optional, Sequence, Tuple

NEG_INF = float("-inf")


@dataclass(frozen=True)
class TrakeCandidate:
    """One retrieved frame for one event, within one video."""

    frame_id: int
    score: float
    # Optional event-calibrated score used only by the sequence optimizer.
    # ``score`` remains the raw hybrid score exposed to callers/UI.
    objective_score: Optional[float] = None
    timestamp_seconds: Optional[float] = None

    @property
    def optimization_score(self) -> float:
        return self.score if self.objective_score is None else self.objective_score


@dataclass(frozen=True)
class TrakeAlignment:
    """A full event->frame assignment for one video.

    ``frame_ids``/``scores`` are one entry per REQUESTED event, in order.
    An entry is ``None``/``0.0`` for an event this video had no candidate
    for and was allowed to skip (see ``rank_trake_videos``'s
    ``max_missing_events``) — the organizer's TRAKEAnswer contract still
    expects one slot per moment, so missing moments stay visible as gaps
    rather than shifting later frame_ids into the wrong position.
    """

    video_id: str
    frame_ids: Tuple[Optional[int], ...]
    scores: Tuple[float, ...]
    sequence_score: Optional[float] = None
    video_prior: float = 0.0
    video_prior_weight: float = 0.0

    @property
    def total_score(self) -> float:
        return sum(self.scores)

    @property
    def missing_events(self) -> int:
        return sum(1 for f in self.frame_ids if f is None)

    @property
    def ranking_score(self) -> float:
        sequence = self.total_score if self.sequence_score is None else self.sequence_score
        return sequence + self.video_prior_weight * self.video_prior


@dataclass(frozen=True)
class TrakeVideoProposal:
    """Video-level consensus before exact moment localization."""

    video_id: str
    coverage: int
    score: float
    event_ranks: Tuple[Optional[int], ...]


def propose_trake_videos(
    per_event_hits: Sequence[Dict[str, List[TrakeCandidate]]],
    top_k_videos: int,
    *,
    rrf_k: int = 10,
    coverage_weight: float = 0.25,
) -> List[TrakeVideoProposal]:
    """Fuse per-event *video* ranks into a robust shortlist.

    Frame-heavy videos get only one vote per event. A video may therefore be
    shortlisted from strong evidence in N-1 events and recovered by targeted
    localization, instead of being discarded by an early strict intersection.
    """
    if not per_event_hits or top_k_videos <= 0:
        return []
    if rrf_k < 0 or coverage_weight < 0:
        raise ValueError("proposal parameters must be non-negative")

    event_video_ranks: List[Dict[str, int]] = []
    all_videos = set()
    for event_hits in per_event_hits:
        ranked = sorted(
            (
                (
                    video_id,
                    max(candidate.optimization_score for candidate in candidates),
                )
                for video_id, candidates in event_hits.items()
                if candidates
            ),
            key=lambda item: (-item[1], item[0]),
        )
        ranks = {video_id: rank for rank, (video_id, _) in enumerate(ranked, 1)}
        event_video_ranks.append(ranks)
        all_videos.update(ranks)

    num_events = len(per_event_hits)
    proposals = []
    for video_id in all_videos:
        ranks = tuple(ranking.get(video_id) for ranking in event_video_ranks)
        present = [rank for rank in ranks if rank is not None]
        coverage = len(present)
        score = sum(1.0 / (rrf_k + rank) for rank in present)
        score += coverage_weight * coverage / num_events
        proposals.append(
            TrakeVideoProposal(
                video_id=video_id,
                coverage=coverage,
                score=score,
                event_ranks=ranks,
            )
        )
    # The shortlist must never evict an already full-coverage story in favour
    # of a high-scoring partial one. Targeted retrieval exists to repair the
    # remaining slots after those anchors are retained.
    proposals.sort(key=lambda item: (-item.coverage, -item.score, item.video_id))
    return proposals[:top_k_videos]


def _align_events_with_objective(
    per_event_candidates: Sequence[Sequence[TrakeCandidate]],
    *,
    gap_penalty: float = 0.0,
    gap_scale_seconds: float = 45.0,
    short_gap_penalty: float = 0.0,
    min_gap_seconds: float = 0.0,
) -> Optional[Tuple[Tuple[int, ...], Tuple[float, ...], float]]:
    """Return frames, raw scores and the calibrated temporal objective."""
    if not per_event_candidates or any(not c for c in per_event_candidates):
        return None
    if gap_penalty < 0:
        raise ValueError("gap_penalty must be non-negative")
    if short_gap_penalty < 0:
        raise ValueError("short_gap_penalty must be non-negative")
    if min_gap_seconds < 0:
        raise ValueError("min_gap_seconds must be non-negative")
    if gap_scale_seconds <= 0:
        raise ValueError("gap_scale_seconds must be positive")

    # A frame can occur more than once when signals agree. Keep the candidate
    # with the strongest optimization score and retain its raw diagnostic score.
    events: List[List[TrakeCandidate]] = []
    for candidates in per_event_candidates:
        best: Dict[int, TrakeCandidate] = {}
        for candidate in candidates:
            current = best.get(candidate.frame_id)
            if current is None or candidate.optimization_score > current.optimization_score:
                best[candidate.frame_id] = candidate
        events.append(sorted(best.values(), key=lambda candidate: candidate.frame_id))

    # Candidate pools are deliberately capped per video by the orchestrator,
    # so this O(E*C^2) DP can use an exact pairwise soft transition cost.
    # Long valid stories remain possible: log1p grows slowly and is never a
    # hard maximum-duration constraint.
    prev = [
        (candidate, candidate.optimization_score, -1)
        for candidate in events[0]
    ]
    history = [prev]
    for candidates in events[1:]:
        current = []
        for candidate in candidates:
            best_total, best_parent = NEG_INF, -1
            for parent_idx, (parent, parent_total, _) in enumerate(prev):
                if parent_total == NEG_INF or parent.frame_id >= candidate.frame_id:
                    continue
                if (
                    parent.timestamp_seconds is not None
                    and candidate.timestamp_seconds is not None
                ):
                    gap_seconds = max(
                        0.0, candidate.timestamp_seconds - parent.timestamp_seconds
                    )
                else:
                    # Frame ids in the corpus are ordinarily 25 fps. This is
                    # only a deterministic fallback for pure/unit-test inputs.
                    gap_seconds = (candidate.frame_id - parent.frame_id) / 25.0
                transition_cost = gap_penalty * math.log1p(
                    gap_seconds / gap_scale_seconds
                )
                if min_gap_seconds > 0 and gap_seconds < min_gap_seconds:
                    transition_cost += short_gap_penalty * (
                        1.0 - gap_seconds / min_gap_seconds
                    )
                total = parent_total + candidate.optimization_score - transition_cost
                if total > best_total:
                    best_total, best_parent = total, parent_idx
            current.append((candidate, best_total, best_parent))
        prev = current
        history.append(prev)

    end_idx, end_total = -1, NEG_INF
    for idx, (candidate, total, _) in enumerate(prev):
        if total > end_total:
            end_total, end_idx = total, idx
    if end_idx < 0 or end_total == NEG_INF:
        return None

    selected: List[TrakeCandidate] = []
    level, idx = len(history) - 1, end_idx
    while idx >= 0:
        candidate, _, parent_idx = history[level][idx]
        selected.append(candidate)
        idx = parent_idx
        level -= 1
    selected.reverse()
    return (
        tuple(candidate.frame_id for candidate in selected),
        tuple(candidate.score for candidate in selected),
        end_total,
    )


def align_events_in_video(
    per_event_candidates: Sequence[Sequence[TrakeCandidate]],
    *,
    gap_penalty: float = 0.0,
    gap_scale_seconds: float = 45.0,
    short_gap_penalty: float = 0.0,
    min_gap_seconds: float = 0.0,
) -> Optional[Tuple[Tuple[int, ...], Tuple[float, ...]]]:
    """Best strictly-increasing frame assignment across events, or None.

    Returns None when any event has no candidate in this video or no
    strictly-increasing chain exists (e.g. all of event 2's frames precede
    all of event 1's).
    """
    result = _align_events_with_objective(
        per_event_candidates,
        gap_penalty=gap_penalty,
        gap_scale_seconds=gap_scale_seconds,
        short_gap_penalty=short_gap_penalty,
        min_gap_seconds=min_gap_seconds,
    )
    if result is None:
        return None
    frames, scores, _ = result
    return frames, scores


def rank_trake_videos(
    per_event_hits: Sequence[Dict[str, List[TrakeCandidate]]],
    top_k_videos: int,
    *,
    max_missing_events: int = 0,
    gap_penalty: float = 0.0,
    gap_scale_seconds: float = 45.0,
    short_gap_penalty: float = 0.0,
    min_gap_seconds: float = 0.0,
    video_priors: Optional[Dict[str, float]] = None,
    video_prior_weight: float = 0.0,
) -> List[TrakeAlignment]:
    """Rank videos by their best full-sequence alignment.

    ``per_event_hits[i]`` maps video_id -> candidates for event i. With the
    default ``max_missing_events=0``, a video must have a candidate for
    EVERY event (the original strict contract) — a video present in all N
    events is exactly the intersection this used to compute directly, so
    this stays behaviorally identical to the pre-2026-08-09 version at the
    default.

    ``max_missing_events > 0`` loosens this: a video missing up to that
    many events is still considered, aligning only the events it DOES have
    candidates for (via the same align_events_in_video DP, on that
    subsequence) — found necessary against a real deployed query (a 4-event
    lion-dance TRAKE query that returned 0 videos because no single video
    ranked in every event's own top-N candidate pool). Missing events are
    reported as ``None`` in the result rather than silently dropped from
    the output shape, since the organizer's TRAKEAnswer contract expects
    one slot per requested moment.
    """
    if not per_event_hits:
        return []
    if max_missing_events < 0:
        raise ValueError("max_missing_events must be non-negative")
    if video_prior_weight < 0:
        raise ValueError("video_prior_weight must be non-negative")

    num_events = len(per_event_hits)
    candidate_videos: set = set()
    for event_hits in per_event_hits:
        candidate_videos.update(event_hits)

    alignments: List[TrakeAlignment] = []
    for video_id in candidate_videos:
        present_event_indices = [
            i for i, event_hits in enumerate(per_event_hits) if video_id in event_hits
        ]
        if num_events - len(present_event_indices) > max_missing_events:
            continue

        assignment = _align_events_with_objective(
            [per_event_hits[i][video_id] for i in present_event_indices],
            gap_penalty=gap_penalty,
            gap_scale_seconds=gap_scale_seconds,
            short_gap_penalty=short_gap_penalty,
            min_gap_seconds=min_gap_seconds,
        )
        if assignment is None:
            continue
        present_frames, present_scores, sequence_score = assignment

        frame_ids: List[Optional[int]] = [None] * num_events
        scores: List[float] = [0.0] * num_events
        for slot, event_idx in enumerate(present_event_indices):
            frame_ids[event_idx] = present_frames[slot]
            scores[event_idx] = present_scores[slot]

        alignments.append(
            TrakeAlignment(
                video_id=video_id,
                frame_ids=tuple(frame_ids),
                scores=tuple(scores),
                sequence_score=sequence_score,
                video_prior=(video_priors or {}).get(video_id, 0.0),
                video_prior_weight=video_prior_weight,
            )
        )

    # Coverage is the strongest video-level signal in TRAKE. Never let one
    # very confident event make a partial story outrank a full ordered story.
    alignments.sort(key=lambda a: (a.missing_events, -a.ranking_score, a.video_id))
    return alignments[:top_k_videos]


__all__ = [
    "TrakeAlignment",
    "TrakeCandidate",
    "TrakeVideoProposal",
    "align_events_in_video",
    "propose_trake_videos",
    "rank_trake_videos",
]
