"""Ground-truth-free KCP event aggregation for online retrieval.

The offline V2 prototype evaluated only events from the ground-truth video.
This module intentionally ranks events from *all* candidate videos so it can
be used by a real backend without evaluation leakage.
"""
from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass, field
import json
import math
from pathlib import Path
import re
from typing import Any, Dict, Mapping, Sequence


@dataclass
class RankedKCPEvent:
    video_id: str
    event_id: str
    score: float = 0.0
    member_doc_ids: set[str] = field(default_factory=set)
    supporting_lanes: set[str] = field(default_factory=set)
    member_scores: Dict[str, float] = field(default_factory=dict)
    visual_member_scores: Dict[str, float] = field(default_factory=dict)
    lane_scores: Dict[str, float] = field(default_factory=dict)

    @property
    def representative_doc_id(self) -> str | None:
        scores = self.visual_member_scores or self.member_scores
        if not scores:
            return None
        return max(scores, key=lambda doc_id: (scores[doc_id], doc_id))

    def diverse_member_doc_ids(
        self, *, limit: int = 3, min_frame_gap: int = 75
    ) -> list[str]:
        """Return several temporally distinct candidates from this event.

        Visual members are preferred, but text-only evidence remains as a
        fallback.  Keeping multiple members avoids prematurely destroying
        frame recall before a dense in-event scanner is available.
        """
        if limit <= 0:
            return []
        primary_scores = self.visual_member_scores or self.member_scores
        ordered = sorted(
            primary_scores,
            key=lambda doc_id: (-primary_scores[doc_id], doc_id),
        )
        # Append non-visual members so exact OCR/ASR evidence is not lost.
        ordered.extend(
            doc_id
            for doc_id in sorted(
                self.member_scores,
                key=lambda item: (-self.member_scores[item], item),
            )
            if doc_id not in primary_scores
        )
        selected: list[str] = []
        selected_frames: list[int] = []
        deferred: list[str] = []
        for doc_id in ordered:
            try:
                frame_id = int(doc_id.rsplit(":", 1)[1])
            except (IndexError, ValueError):
                deferred.append(doc_id)
                continue
            if any(abs(frame_id - other) < min_frame_gap for other in selected_frames):
                deferred.append(doc_id)
                continue
            selected.append(doc_id)
            selected_frames.append(frame_id)
            if len(selected) >= limit:
                return selected
        # Short events may not contain enough diverse frames. Fill remaining
        # slots rather than silently collapsing back to one representative.
        for doc_id in deferred:
            if doc_id not in selected:
                selected.append(doc_id)
            if len(selected) >= limit:
                break
        return selected


class KCPEventIndex:
    """Resolve arbitrary candidate frames to precomputed KCP events."""

    def __init__(self, segments: Mapping[str, Mapping[str, Any]]) -> None:
        self._event_by_frame: Dict[str, Dict[int, str]] = {}
        self._frames: Dict[str, list[int]] = {}
        for video_id, frame_map in segments.items():
            parsed = {int(frame): str(event_id) for frame, event_id in frame_map.items()}
            self._event_by_frame[str(video_id)] = parsed
            self._frames[str(video_id)] = sorted(parsed)

    @classmethod
    def from_json(cls, path: str | Path) -> "KCPEventIndex":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        segments = payload.get("segments") if isinstance(payload, dict) else None
        if not isinstance(segments, dict):
            raise ValueError("KCP artifact must contain a 'segments' mapping")
        return cls(segments)

    def resolve(
        self, video_id: str, frame_id: int, *, nearest_tolerance: int = 60
    ) -> str | None:
        mapping = self._event_by_frame.get(str(video_id))
        frames = self._frames.get(str(video_id))
        if not mapping or not frames:
            return None
        frame_id = int(frame_id)
        exact = mapping.get(frame_id)
        if exact is not None:
            return exact
        pos = bisect_left(frames, frame_id)
        neighbors = []
        if pos < len(frames):
            neighbors.append(frames[pos])
        if pos:
            neighbors.append(frames[pos - 1])
        if not neighbors:
            return None
        nearest = min(neighbors, key=lambda frame: (abs(frame - frame_id), frame))
        if abs(nearest - frame_id) > nearest_tolerance:
            return None
        return mapping[nearest]

    def frames_for_event(self, video_id: str, event_id: str) -> list[int]:
        """Return indexed keyframes belonging to one KCP event."""
        mapping = self._event_by_frame.get(str(video_id), {})
        return sorted(
            frame for frame, candidate_event in mapping.items()
            if candidate_event == str(event_id)
        )

    def ordered_events(self, video_id: str) -> list[tuple[str, list[int]]]:
        """Return a video's KCP events in temporal order with their frames."""
        grouped: Dict[str, list[int]] = {}
        for frame, event_id in self._event_by_frame.get(str(video_id), {}).items():
            grouped.setdefault(event_id, []).append(int(frame))
        rows = [(event_id, sorted(frames)) for event_id, frames in grouped.items()]
        rows.sort(key=lambda row: (row[1][0], row[0]))
        return rows

    def neighboring_events(
        self, video_id: str, event_id: str
    ) -> list[tuple[str, list[int]]]:
        """Previous/current/next KCP events for temporal and boundary context."""
        events = self.ordered_events(video_id)
        position = next(
            (index for index, row in enumerate(events) if row[0] == str(event_id)),
            None,
        )
        if position is None:
            return []
        return events[max(0, position - 1): min(len(events), position + 2)]


def rank_kcp_events(
    signal_groups: Mapping[str, Sequence[Any]],
    event_index: KCPEventIndex,
    *,
    lane_weights: Mapping[str, float],
    rrf_k: int = 30,
    nearest_tolerance: int = 60,
) -> list[RankedKCPEvent]:
    """Aggregate every candidate video globally into KCP event records."""
    events: Dict[tuple[str, str], RankedKCPEvent] = {}
    clause_counts: Dict[str, int] = {}
    for lane_name in signal_groups:
        base_lane = lane_name.split("__clause", 1)[0]
        if "__clause" in lane_name:
            clause_counts[base_lane] = clause_counts.get(base_lane, 0) + 1
    for lane_name, signals in signal_groups.items():
        base_lane = lane_name.split("__clause", 1)[0]
        weight = float(lane_weights.get(base_lane, lane_weights.get(lane_name, 1.0)))
        if "__clause" in lane_name:
            weight /= max(1, clause_counts.get(base_lane, 1))
        # A repeated frame in one lane is one piece of evidence, not several.
        best_rank_by_doc: Dict[str, int] = {}
        signal_by_doc: Dict[str, Any] = {}
        for signal in signals:
            doc_id = f"{signal.video_id}:{int(signal.frame_id)}"
            rank = max(1, int(signal.rank))
            if rank < best_rank_by_doc.get(doc_id, 10**18):
                best_rank_by_doc[doc_id] = rank
                signal_by_doc[doc_id] = signal

        for doc_id, rank in best_rank_by_doc.items():
            signal = signal_by_doc[doc_id]
            event_id = event_index.resolve(
                signal.video_id,
                signal.frame_id,
                nearest_tolerance=nearest_tolerance,
            )
            if event_id is None:
                continue
            contribution = weight / (rrf_k + rank)
            key = (str(signal.video_id), event_id)
            event = events.setdefault(
                key, RankedKCPEvent(video_id=key[0], event_id=key[1])
            )
            event.score += contribution
            event.member_doc_ids.add(doc_id)
            event.supporting_lanes.add(lane_name)
            event.member_scores[doc_id] = (
                event.member_scores.get(doc_id, 0.0) + contribution
            )
            event.lane_scores[lane_name] = max(
                event.lane_scores.get(lane_name, 0.0), contribution
            )
            if lane_name.startswith("visual_"):
                event.visual_member_scores[doc_id] = (
                    event.visual_member_scores.get(doc_id, 0.0) + contribution
                )

    return sorted(
        events.values(),
        key=lambda event: (-event.score, event.video_id, event.event_id),
    )


def boost_temporal_event_coherence(
    events: Sequence[RankedKCPEvent],
    event_index: KCPEventIndex,
    *,
    bonus: float = 0.10,
) -> list[RankedKCPEvent]:
    """Give a bounded lift to adjacent evidence for temporal queries.

    This is intentionally a reordering-only step: it never invents an event
    or adds a frame that retrieval did not produce.  When two neighboring KCP
    events from the same video are already supported, both receive a small
    coherence lift so a transition/sequence is less likely to be split by
    unrelated single-scene hits.  Ordinary (non-temporal) queries do not call
    this helper.
    """
    if not events or bonus <= 0.0:
        return list(events)
    present = {(str(event.video_id), str(event.event_id)) for event in events}
    bounded_bonus = min(float(bonus), 0.25)
    output: list[RankedKCPEvent] = []
    for event in events:
        neighbors = event_index.neighboring_events(
            event.video_id, event.event_id
        )
        adjacent = sum(
            1
            for neighbor_id, _frames in neighbors
            if neighbor_id != str(event.event_id)
            and (str(event.video_id), str(neighbor_id)) in present
        )
        if adjacent:
            event.score *= 1.0 + bounded_bonus * min(adjacent, 2)
        output.append(event)
    return sorted(
        output,
        key=lambda event: (-event.score, -len(event.supporting_lanes),
                           event.video_id, event.event_id),
    )


def rank_local_kcp_events(
    signal_groups: Mapping[str, Sequence[Any]],
    event_index: KCPEventIndex,
    *,
    lane_weights: Mapping[str, float],
    allowed_videos: Sequence[str],
    nearest_tolerance: int = 60,
) -> list[RankedKCPEvent]:
    """Rank scenes inside video-RRF's shortlist using local evidence.

    This deliberately avoids feeding deep hits back through global frame RRF.
    Raw similarity is normalized within each lane, and one lane contributes
    at most its strongest hit to an event so dense scenes cannot win by count.
    """
    allowed = {str(video_id) for video_id in allowed_videos}
    if not allowed:
        return []

    def base_lane_name(lane_name: str) -> str:
        without_clause = lane_name.split("__clause", 1)[0]
        if without_clause.startswith("caption_"):
            return "caption"
        return without_clause

    events: Dict[tuple[str, str], RankedKCPEvent] = {}
    clause_counts: Dict[str, int] = {}
    for lane_name in signal_groups:
        base_lane = base_lane_name(lane_name)
        if "__clause" in lane_name:
            clause_counts[base_lane] = clause_counts.get(base_lane, 0) + 1
    for lane_name, signals in signal_groups.items():
        best_signal_by_doc: Dict[str, Any] = {}
        for signal in signals:
            video_id = str(signal.video_id)
            if video_id not in allowed:
                continue
            doc_id = f"{video_id}:{int(signal.frame_id)}"
            previous = best_signal_by_doc.get(doc_id)
            if previous is None or float(signal.score) > float(previous.score):
                best_signal_by_doc[doc_id] = signal
        if not best_signal_by_doc:
            continue

        raw_scores = [float(signal.score) for signal in best_signal_by_doc.values()]
        score_min = min(raw_scores)
        score_span = max(raw_scores) - score_min
        base_lane = base_lane_name(lane_name)
        weight = float(lane_weights.get(base_lane, lane_weights.get(lane_name, 1.0)))
        if "__clause" in lane_name:
            weight /= max(1, clause_counts.get(base_lane, 1))
        docs_by_event: Dict[tuple[str, str], list[tuple[str, float]]] = {}
        for doc_id, signal in best_signal_by_doc.items():
            event_id = event_index.resolve(
                signal.video_id,
                signal.frame_id,
                nearest_tolerance=nearest_tolerance,
            )
            if event_id is None:
                continue
            if score_span > 1e-12:
                normalized = (float(signal.score) - score_min) / score_span
            else:
                # A flat lane is common for sparse/quantized scores.  Giving
                # every hit exactly 1.0 makes event order depend only on
                # insertion order.  Retain the lane's raw relative signal
                # instead; this is deliberately bounded and GT-free.
                mean_score = sum(raw_scores) / max(1, len(raw_scores))
                normalized = (
                    float(signal.score) / mean_score
                    if mean_score > 0.0 else 1.0
                )
                normalized = max(0.0, min(1.0, normalized))
            contribution = weight * (0.25 + 0.75 * normalized)
            key = (str(signal.video_id), str(event_id))
            docs_by_event.setdefault(key, []).append((doc_id, contribution))

        for key, documents in docs_by_event.items():
            contribution = max(score for _, score in documents)
            event = events.setdefault(
                key, RankedKCPEvent(video_id=key[0], event_id=key[1])
            )
            event.score += contribution
            event.supporting_lanes.add(lane_name)
            event.lane_scores[lane_name] = max(
                event.lane_scores.get(lane_name, 0.0), contribution
            )
            for doc_id, doc_score in documents:
                event.member_doc_ids.add(doc_id)
                event.member_scores[doc_id] = (
                    event.member_scores.get(doc_id, 0.0) + doc_score
                )
                if lane_name.startswith("visual_"):
                    event.visual_member_scores[doc_id] = (
                        event.visual_member_scores.get(doc_id, 0.0) + doc_score
                    )

    return sorted(
        events.values(),
        key=lambda event: (
            -event.score,
            -len(event.supporting_lanes),
            event.video_id,
            event.event_id,
        ),
    )


def rank_events_by_clause_coverage(
    events: Sequence[RankedKCPEvent],
    *,
    temporal: bool,
) -> list[RankedKCPEvent]:
    """Group local events by video and reward full multi-clause coverage.

    For temporal queries, a dynamic program chooses one non-decreasing event
    per clause. Non-temporal queries independently choose the strongest event
    for each clause. The winning video's selected events are returned together
    so a sequence is never collapsed to a single, possibly wrong frame.
    """
    clause_pattern = re.compile(r"__clause(\d+)$")

    def event_frame(event: RankedKCPEvent) -> int:
        frames = []
        for doc_id in event.member_doc_ids:
            try:
                frames.append(int(doc_id.rsplit(":", 1)[1]))
            except (IndexError, ValueError):
                continue
        return min(frames) if frames else 0

    clause_ids = sorted(
        {
            int(match.group(1))
            for event in events
            for lane in event.lane_scores
            for match in [clause_pattern.search(lane)]
            if match
        }
    )
    if len(clause_ids) <= 1:
        return list(events)

    by_video: Dict[str, list[RankedKCPEvent]] = {}
    for event in events:
        by_video.setdefault(event.video_id, []).append(event)

    ranked_sequences = []
    for video_id, video_events in by_video.items():
        video_events.sort(key=lambda event: (event_frame(event), event.event_id))
        scores: Dict[tuple[int, str], float] = {}
        for clause_id in clause_ids:
            suffix = f"__clause{clause_id}"
            for event in video_events:
                scores[(clause_id, event.event_id)] = sum(
                    score
                    for lane, score in event.lane_scores.items()
                    if lane.endswith(suffix)
                )

        selected: list[RankedKCPEvent] = []
        clause_scores: list[float] = []
        if temporal:
            states: list[tuple[float, int, list[RankedKCPEvent], list[float]]] = []
            for clause_index, clause_id in enumerate(clause_ids):
                next_states = []
                for event in video_events:
                    score = scores.get((clause_id, event.event_id), 0.0)
                    if score <= 0.0:
                        continue
                    frame = event_frame(event)
                    if clause_index == 0:
                        next_states.append((math.log(score + 1e-9), frame, [event], [score]))
                        continue
                    valid = [state for state in states if state[1] <= frame]
                    if not valid:
                        continue
                    prior = max(valid, key=lambda state: state[0])
                    next_states.append(
                        (
                            prior[0] + math.log(score + 1e-9),
                            frame,
                            prior[2] + [event],
                            prior[3] + [score],
                        )
                    )
                states = next_states
                if not states:
                    break
            if states:
                best = max(states, key=lambda state: state[0])
                selected, clause_scores = best[2], best[3]
        else:
            for clause_id in clause_ids:
                candidates = [
                    (scores.get((clause_id, event.event_id), 0.0), event)
                    for event in video_events
                ]
                score, event = max(candidates, key=lambda item: item[0])
                if score > 0.0:
                    selected.append(event)
                    clause_scores.append(score)

        coverage = len(clause_scores) / len(clause_ids)
        if not clause_scores:
            continue
        geometric = math.exp(
            sum(math.log(score + 1e-9) for score in clause_scores)
            / len(clause_scores)
        )
        weakest = min(clause_scores)
        sequence_score = coverage * coverage * geometric * (0.5 + 0.5 * weakest)
        deduped = []
        seen_events = set()
        for event in selected:
            if event.event_id in seen_events:
                continue
            seen_events.add(event.event_id)
            deduped.append(event)
        ranked_sequences.append((sequence_score, coverage, video_id, deduped))

    ranked_sequences.sort(key=lambda item: (-item[0], -item[1], item[2]))
    flattened: list[RankedKCPEvent] = []
    seen = set()
    for sequence_score, coverage, _, selected in ranked_sequences:
        for order, event in enumerate(selected):
            key = (event.video_id, event.event_id)
            if key in seen:
                continue
            seen.add(key)
            event.score = sequence_score * (1.0 - 0.01 * order)
            flattened.append(event)
    # Backfill local events not selected by a complete/partial sequence.
    flattened.extend(
        event
        for event in events
        if (event.video_id, event.event_id) not in seen
    )
    return flattened


def shortlist_videos_for_deep_search(
    signal_groups: Mapping[str, Sequence[Any]],
    *,
    lane_weights: Mapping[str, float],
    limit: int = 20,
    visual_quota_per_lane: int = 5,
    rrf_k: int = 30,
) -> list[str]:
    """Collapse global frame hits to a robust video shortlist.

    Each lane contributes only its best rank for a video, preventing many
    near-duplicate frames from one scene from crowding the video score.  A
    small quota from every visual lane is guaranteed before weighted video
    RRF fills the remaining slots; this preserves videos found strongly by
    only one complementary visual encoder.
    """
    if limit <= 0:
        return []

    video_scores: Dict[str, float] = {}
    visual_seeds: set[str] = set()
    text_seeds: set[str] = set()
    best_lane_rank: Dict[str, int] = {}
    text_lanes = {"ocr", "ocr_sqlite", "audio", "caption"}
    for lane_name, signals in signal_groups.items():
        base_lane = lane_name.split("__clause", 1)[0]
        best_rank: Dict[str, int] = {}
        for signal in signals:
            video_id = str(signal.video_id)
            rank = max(1, int(signal.rank))
            if rank < best_rank.get(video_id, 10**18):
                best_rank[video_id] = rank

        weight = float(
            lane_weights.get(base_lane, lane_weights.get(lane_name, 1.0))
        )
        for video_id, rank in best_rank.items():
            video_scores[video_id] = (
                video_scores.get(video_id, 0.0) + weight / (rrf_k + rank)
            )
            best_lane_rank[video_id] = min(
                best_lane_rank.get(video_id, 10**18), rank
            )

        if lane_name.startswith("visual_") and visual_quota_per_lane > 0:
            visual_seeds.update(
                video_id
                for video_id, _ in sorted(
                    best_rank.items(), key=lambda item: (item[1], item[0])
                )[:visual_quota_per_lane]
            )
        elif base_lane in text_lanes:
            # Keep a bounded text escape quota.  Without this, a visual lane
            # can consume the whole lock shortlist even when OCR/ASR/caption
            # is the only evidence for the correct episode.
            text_seeds.update(
                video_id
                for video_id, _ in sorted(
                    best_rank.items(), key=lambda item: (item[1], item[0])
                )[:3]
            )

    ranking = sorted(video_scores, key=lambda video: (-video_scores[video], video))
    seed_set = visual_seeds | text_seeds
    seed_ranking = sorted(
        seed_set,
        key=lambda video: (
            best_lane_rank.get(video, 10**18),
            -video_scores.get(video, 0.0),
            video,
        ),
    )
    if len(seed_ranking) >= limit:
        return seed_ranking[:limit]

    selected = list(seed_ranking)
    selected_set = set(selected)
    for video_id in ranking:
        if video_id in selected_set:
            continue
        selected.append(video_id)
        selected_set.add(video_id)
        if len(selected) >= limit:
            break
    return selected
