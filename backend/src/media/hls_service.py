"""On-demand HLS packaging for source .mp4 videos.

Remuxes (no re-encode) a video into an HLS playlist + .ts segments the first
time it is requested, caching the result under ``hls_cache_dir/<video_id>/``
so every later request is a plain file read. ``-c copy`` is used first since
the batch1 corpus is already H.264/AAC (remux only, seconds not minutes even
for the largest ~340MB file); a transcode is retried only if that fails, so
a source with an incompatible codec still produces a playable HLS output.
"""
from __future__ import annotations

import re
import subprocess
import threading
from pathlib import Path

_SEGMENT_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+\.ts$")

# One lock per video_id so concurrent requests for DIFFERENT videos don't
# serialize behind each other, guarded by _locks_lock the same
# double-checked-locking way ResourceManager guards its lazy-loaded
# resources (see src/pipeline/resource_manager.py).
_locks_lock = threading.Lock()
_video_locks: dict[str, threading.Lock] = {}


def _lock_for(video_id: str) -> threading.Lock:
    lock = _video_locks.get(video_id)
    if lock is None:
        with _locks_lock:
            lock = _video_locks.get(video_id)
            if lock is None:
                lock = threading.Lock()
                _video_locks[video_id] = lock
    return lock


def is_valid_segment_name(name: str) -> bool:
    """True for exactly the filenames this module ever writes.

    Also the path-traversal defense for the segment route: a name that
    doesn't match can't contain "/", "..", or any character outside
    [0-9_.a-z], so joining it onto a cache directory can never escape it.
    """
    return bool(_SEGMENT_NAME_RE.match(name))


def _run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=False)


def _package(source_path: Path, out_dir: Path, segment_seconds: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    playlist_path = out_dir / "playlist.m3u8"
    segment_pattern = str(out_dir / "seg_%05d.ts")

    hls_output_args = [
        "-start_number",
        "0",
        "-hls_time",
        str(segment_seconds),
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        segment_pattern,
        str(playlist_path),
    ]

    copy_result = _run_ffmpeg(
        ["ffmpeg", "-y", "-i", str(source_path), "-c", "copy", *hls_output_args]
    )
    if copy_result.returncode == 0:
        return

    # Source codec isn't remux-compatible with MPEG-TS (rare in this
    # corpus, but not impossible) — fall back to a real transcode instead
    # of leaving a half-written playlist behind.
    transcode_result = _run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_path),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-c:a",
            "aac",
            *hls_output_args,
        ]
    )
    if transcode_result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed to package {source_path} as HLS "
            f"(copy stderr: {copy_result.stderr[-500:]!r}; "
            f"transcode stderr: {transcode_result.stderr[-500:]!r})"
        )


def ensure_playlist(
    video_id: str, source_path: Path, cache_dir: Path, segment_seconds: int
) -> Path:
    """Return the cached HLS playlist for video_id, packaging it first if needed."""
    out_dir = cache_dir / video_id
    playlist_path = out_dir / "playlist.m3u8"
    index_path = out_dir / "index.m3u8"
    if playlist_path.exists():
        return playlist_path
    if index_path.exists():
        return index_path

    with _lock_for(video_id):
        if playlist_path.exists():  # another thread finished while we waited
            return playlist_path
        if index_path.exists():
            return index_path
        _package(source_path, out_dir, segment_seconds)

    return playlist_path
