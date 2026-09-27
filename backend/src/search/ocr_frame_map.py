"""Serve OCR text for frames that never went through the OCR engines.

Selection (:mod:`src.data.ocr_frame_selection`) runs OCR on ~13.6% of the
corpus and records, for every other frame, which representative it inherits
text from. Without this module that inheritance is inert: a query would
only ever hit the 320k representatives, and the other 2.03M frames would be
invisible even though their text is known.

Expansion happens at **hit time**, not load time. Materializing a record per
frame would mean 2.35M dictionaries in memory for a corpus whose text only
has 320k distinct entries; expanding the handful of documents a query
actually matched costs nothing by comparison.

Scores decay with temporal distance: a frame 4 seconds from its
representative is a weaker piece of evidence than the representative
itself, and ranking should say so rather than pretend they are equal.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from loguru import logger

#: Score multiplier at ``max_distance`` seconds; nearer frames interpolate
#: linearly between 1.0 and this floor.
DEFAULT_MIN_INHERITED_WEIGHT = 0.6
#: Distance at which the floor is reached. Matches the selector's own gap
#: cap, so a frame can never be weighted below the floor.
DEFAULT_MAX_DISTANCE_SECONDS = 8.0


@dataclass
class OCRFrameMap:
    """frame -> representative, and the reverse, per video."""

    #: (video_id, representative_frame_id) -> [(frame_id, distance_seconds)]
    inheritors_by_representative: Dict[Tuple[str, int], List[Tuple[int, float]]] = field(
        default_factory=lambda: defaultdict(list)
    )

    def inheritors(
        self, video_id: str, representative_frame_id: int
    ) -> List[Tuple[int, float]]:
        return self.inheritors_by_representative.get(
            (video_id, int(representative_frame_id)), []
        )

    def __len__(self) -> int:
        return sum(
            len(frames) for frames in self.inheritors_by_representative.values()
        )


def load_frame_map(paths: Sequence[Path]) -> OCRFrameMap:
    """Read and validate all ``ocr_frame_map*.jsonl`` shards.

    Representative rows are validated and counted for duplicate detection,
    then dropped because the representative already has its own OCR record.
    Any malformed row is an artifact error, not a reason to silently lose
    part of the frame-level recall surface.
    """
    frame_map = OCRFrameMap()
    seen_frames = set()
    for raw_path in paths:
        path = Path(raw_path)
        if not path.is_file():
            raise FileNotFoundError(f"frame map does not exist: {path}")
        with path.open("r", encoding="utf-8") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(
                        f"{path}:{line_number}: invalid JSON"
                    ) from exc
                if not isinstance(row, dict):
                    raise ValueError(
                        f"{path}:{line_number}: row must be a JSON object"
                    )

                video_id = row.get("video_id")
                frame_value = row.get("frame_id")
                representative_value = row.get("ocr_frame_id")
                if not isinstance(video_id, str) or not video_id.strip():
                    raise ValueError(
                        f"{path}:{line_number}: missing video_id"
                    )
                if isinstance(frame_value, bool) or isinstance(
                    representative_value, bool
                ):
                    raise ValueError(
                        f"{path}:{line_number}: invalid frame id"
                    )
                try:
                    frame_id = int(frame_value)
                    representative = int(representative_value)
                except (TypeError, ValueError) as exc:
                    raise ValueError(
                        f"{path}:{line_number}: invalid frame id"
                    ) from exc
                if frame_id < 0 or representative < 0:
                    raise ValueError(
                        f"{path}:{line_number}: frame ids must be non-negative"
                    )

                distance_value = row.get("temporal_distance_seconds", 0.0)
                try:
                    distance = float(distance_value)
                except (TypeError, ValueError) as exc:
                    raise ValueError(
                        f"{path}:{line_number}: invalid temporal distance"
                    ) from exc
                if not math.isfinite(distance) or distance < 0.0:
                    raise ValueError(
                        f"{path}:{line_number}: invalid temporal distance"
                    )

                is_representative = row.get(
                    "is_representative", frame_id == representative
                )
                if not isinstance(is_representative, bool):
                    raise ValueError(
                        f"{path}:{line_number}: invalid representative flag"
                    )
                if is_representative != (frame_id == representative):
                    raise ValueError(
                        f"{path}:{line_number}: representative flag does not "
                        "match frame ids"
                    )
                frame_key = (video_id, frame_id)
                if frame_key in seen_frames:
                    raise ValueError(
                        f"{path}:{line_number}: duplicate frame mapping "
                        f"{video_id}:{frame_id}"
                    )
                seen_frames.add(frame_key)
                if is_representative:
                    continue
                frame_map.inheritors_by_representative[
                    (video_id, representative)
                ].append((frame_id, distance))
    logger.info(f"Loaded OCR frame map: {len(frame_map)} inherited frames")
    return frame_map


def inherited_weight(
    distance_seconds: float,
    *,
    min_weight: float = DEFAULT_MIN_INHERITED_WEIGHT,
    max_distance: float = DEFAULT_MAX_DISTANCE_SECONDS,
) -> float:
    """Linear decay from 1.0 at the representative to ``min_weight``."""
    if not 0.0 < min_weight <= 1.0:
        raise ValueError("min_weight must be in (0, 1]")
    if max_distance <= 0:
        raise ValueError("max_distance must be > 0")
    distance = max(0.0, float(distance_seconds))
    if distance >= max_distance:
        return min_weight
    return 1.0 - (1.0 - min_weight) * (distance / max_distance)


@dataclass(frozen=True)
class ExpandedHit:
    video_id: str
    frame_id: int
    score: float
    source_frame_id: int
    temporal_distance_seconds: float

    @property
    def is_representative(self) -> bool:
        return self.frame_id == self.source_frame_id


def expand_hits(
    hits: Iterable[Tuple[str, int, float]],
    frame_map: Optional[OCRFrameMap],
    *,
    min_weight: float = DEFAULT_MIN_INHERITED_WEIGHT,
    max_distance: float = DEFAULT_MAX_DISTANCE_SECONDS,
    limit: Optional[int] = None,
) -> List[ExpandedHit]:
    """Turn representative hits into hits on every frame that inherits them.

    ``hits`` are ``(video_id, frame_id, score)`` for frames that really were
    OCR-ed. The result keeps those and adds their inheritors, sorted by
    score. With no frame map the input passes through unchanged, so a
    corpus extracted without selection still works.
    """
    expanded: List[ExpandedHit] = []
    for video_id, frame_id, score in hits:
        expanded.append(
            ExpandedHit(
                video_id=video_id,
                frame_id=int(frame_id),
                score=float(score),
                source_frame_id=int(frame_id),
                temporal_distance_seconds=0.0,
            )
        )
        if frame_map is None:
            continue
        for inherited_frame, distance in frame_map.inheritors(video_id, frame_id):
            expanded.append(
                ExpandedHit(
                    video_id=video_id,
                    frame_id=inherited_frame,
                    score=float(score)
                    * inherited_weight(
                        distance, min_weight=min_weight, max_distance=max_distance
                    ),
                    source_frame_id=int(frame_id),
                    temporal_distance_seconds=float(distance),
                )
            )
    expanded.sort(key=lambda hit: (-hit.score, hit.video_id, hit.frame_id))
    return expanded[:limit] if limit is not None else expanded
