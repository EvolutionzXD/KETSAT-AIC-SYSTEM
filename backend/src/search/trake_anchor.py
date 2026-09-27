"""Pure helpers for anchor-locked TRAKE searches."""
from __future__ import annotations

from bisect import bisect_left
import math
from typing import List, Sequence


def sample_window_frame_ids(
    frame_ids: Sequence[int],
    *,
    fps: float,
    anchor_frame_id: int,
    window_seconds: float,
    sample_fps: float = 2.0,
    max_frames: int = 350,
) -> List[int]:
    """Return chronological nearest keyframes sampled inside an anchor window."""
    if fps <= 0:
        raise ValueError("fps must be positive")
    if window_seconds <= 0:
        raise ValueError("window_seconds must be positive")
    if sample_fps <= 0:
        raise ValueError("sample_fps must be positive")
    if max_frames <= 0:
        raise ValueError("max_frames must be positive")
    available = sorted({
        int(frame)
        for frame in frame_ids
        if isinstance(frame, (int, float)) and int(frame) >= 0
    })
    if not available:
        return []
    anchor_frame_id = max(0, int(anchor_frame_id))
    anchor_seconds = anchor_frame_id / float(fps)
    start_seconds = max(0.0, anchor_seconds - float(window_seconds))
    end_seconds = anchor_seconds + float(window_seconds)
    start_frame = int(math.ceil(start_seconds * fps - 1e-9))
    end_frame = int(math.floor(end_seconds * fps + 1e-9))
    visible = [frame for frame in available if start_frame <= frame <= end_frame]
    if not visible:
        return []
    sample_count = max(
        1, int(math.ceil((end_seconds - start_seconds) * sample_fps)) + 1
    )
    sample_count = min(sample_count, max_frames)
    if sample_count == 1:
        targets = [anchor_seconds]
    else:
        interval = (end_seconds - start_seconds) / float(sample_count - 1)
        targets = [
            start_seconds + interval * index
            for index in range(sample_count)
        ]
    targets.append(anchor_seconds)
    sampled = set()
    for target in targets:
        target_frame = target * fps
        position = bisect_left(visible, target_frame)
        neighbors = []
        if position < len(visible):
            neighbors.append(visible[position])
        if position:
            neighbors.append(visible[position - 1])
        if not neighbors:
            continue
        nearest = min(neighbors, key=lambda frame: (abs(frame - target_frame), frame))
        sampled.add(int(nearest))
    return sorted(sampled)


def sample_forward_window_frame_ids(
    frame_ids: Sequence[int],
    *,
    fps: float,
    anchor_frame_id: int,
    window_seconds: float,
    sample_fps: float = 2.0,
    max_frames: int = 350,
    required_frame_ids: Sequence[int] = (),
) -> List[int]:
    """Sample a chronological window from the anchor towards the future.

    Anchor-locked TRAKE uses the first matched frame as a temporal lower
    bound. Sampling the backward half of a symmetric window lets Vision
    select an unrelated earlier action, especially when the same performers
    occur repeatedly in one broadcast. Required ids are retained even when
    they are not present in the sparse keyframe mapping; this is used for
    exact source-video frames during local refinement.
    """
    if fps <= 0:
        raise ValueError("fps must be positive")
    if window_seconds <= 0:
        raise ValueError("window_seconds must be positive")
    if sample_fps <= 0:
        raise ValueError("sample_fps must be positive")
    if max_frames <= 0:
        raise ValueError("max_frames must be positive")
    available = sorted({
        int(frame)
        for frame in frame_ids
        if isinstance(frame, (int, float)) and int(frame) >= 0
    })
    anchor_frame_id = max(0, int(anchor_frame_id))
    anchor_seconds = anchor_frame_id / float(fps)
    end_seconds = anchor_seconds + float(window_seconds)
    start_frame = anchor_frame_id
    end_frame = int(math.floor(end_seconds * fps + 1e-9))
    visible = [
        frame for frame in available
        if start_frame <= frame <= end_frame
    ]
    sample_count = min(
        max_frames,
        max(1, int(math.ceil(window_seconds * sample_fps)) + 1),
    )
    if sample_count == 1:
        targets = [anchor_seconds]
    else:
        interval = float(window_seconds) / float(sample_count - 1)
        targets = [
            anchor_seconds + interval * index
            for index in range(sample_count)
        ]
    sampled = set()
    for target in targets:
        target_frame = target * fps
        if visible:
            position = bisect_left(visible, target_frame)
            neighbors = []
            if position < len(visible):
                neighbors.append(visible[position])
            if position:
                neighbors.append(visible[position - 1])
            if neighbors:
                sampled.add(min(
                    neighbors,
                    key=lambda frame: (abs(frame - target_frame), frame),
                ))
        else:
            sampled.add(int(round(target_frame)))
    for required in required_frame_ids:
        try:
            frame = int(required)
        except (TypeError, ValueError):
            continue
        if start_frame <= frame <= end_frame:
            sampled.add(frame)
    return sorted(sampled)


def sample_interval_frame_ids(
    frame_ids: Sequence[int],
    *,
    fps: float,
    start_frame_id: int,
    end_frame_id: int,
    sample_fps: float = 5.0,
    max_frames: int = 24,
    required_frame_ids: Sequence[int] = (),
) -> List[int]:
    """Sample only existing keyframes inside an arbitrary interval.

    TRAKE refinement must stay on the extracted candidate-frame grid. This
    helper never fabricates native video frame ids; every returned id is
    selected from frame_ids. Required ids are retained, or snapped to the
    nearest available keyframe when the requested id is not on the grid.
    """
    if fps <= 0:
        raise ValueError("fps must be positive")
    if sample_fps <= 0:
        raise ValueError("sample_fps must be positive")
    if max_frames <= 0:
        raise ValueError("max_frames must be positive")
    available = sorted({
        int(frame)
        for frame in frame_ids
        if isinstance(frame, (int, float)) and int(frame) >= 0
    })
    if not available:
        return []
    start = max(0, int(start_frame_id))
    end = max(start, int(end_frame_id))
    visible = [
        frame for frame in available
        if start <= frame <= end
    ]
    if not visible:
        return []
    interval_seconds = (end - start) / float(fps)
    sample_count = min(
        max_frames,
        max(1, int(math.ceil(interval_seconds * sample_fps)) + 1),
    )
    if sample_count == 1:
        targets = [float(start)]
    else:
        step = (end - start) / float(sample_count - 1)
        targets = [
            start + step * index
            for index in range(sample_count)
        ]
    sampled = set()
    for target in targets:
        position = bisect_left(visible, target)
        neighbors = []
        if position < len(visible):
            neighbors.append(visible[position])
        if position:
            neighbors.append(visible[position - 1])
        if neighbors:
            sampled.add(min(
                neighbors,
                key=lambda frame: (abs(frame - target), frame),
            ))
    required = set()
    for raw_frame in required_frame_ids:
        try:
            frame = int(raw_frame)
        except (TypeError, ValueError):
            continue
        if not start <= frame <= end:
            continue
        if frame in visible:
            required.add(frame)
            continue
        required.add(min(
            visible,
            key=lambda candidate: (abs(candidate - frame), candidate),
        ))
    sampled.update(required)
    if len(sampled) > max_frames and len(required) < max_frames:
        optional = sorted(sampled - required)
        keep_count = max_frames - len(required)
        if keep_count == 1:
            kept = [optional[len(optional) // 2]]
        else:
            positions = sorted({
                int(round(index * (len(optional) - 1) / float(keep_count - 1)))
                for index in range(keep_count)
            })
            kept = [optional[index] for index in positions]
        sampled = required | set(kept)
    return sorted(sampled)


def expand_window_seconds(
    initial_seconds: float = 30.0,
    maximum_seconds: float = 180.0,
) -> List[float]:
    """Return deterministic 30 -> 90 -> 180 style retry windows."""
    if initial_seconds <= 0:
        raise ValueError("initial_seconds must be positive")
    if maximum_seconds <= 0:
        raise ValueError("maximum_seconds must be positive")
    maximum_seconds = max(float(initial_seconds), float(maximum_seconds))
    current = float(initial_seconds)
    values: List[float] = []
    while True:
        value = min(current, maximum_seconds)
        if not values or value > values[-1]:
            values.append(value)
        if value >= maximum_seconds:
            break
        current = min(maximum_seconds, max(current * 3.0, current + 60.0))
    return values
