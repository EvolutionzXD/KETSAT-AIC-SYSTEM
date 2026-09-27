"""File-backed translation cache.

Queries repeat across sessions and the validation set can be pre-translated
once, so an on-disk cache removes most API calls (and cost). Keyed by backend
name + source text so switching backends never returns another engine's output.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Dict, Optional

#: Unit separator — safe key delimiter, never present in query text.
_KEY_SEP = "\x1f"


class TranslationCache:
    """Thread-safe JSON cache of ``(backend, source_text) -> translation``."""

    def __init__(self, path: Optional[Path] = None):
        self._path = Path(path) if path is not None else None
        self._lock = threading.Lock()
        self._store: Dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        if self._path is None or not self._path.is_file():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        if isinstance(data, dict):
            self._store = {str(k): str(v) for k, v in data.items()}

    @staticmethod
    def _key(backend: str, text: str) -> str:
        return f"{backend}{_KEY_SEP}{text}"

    def get(self, backend: str, text: str) -> Optional[str]:
        return self._store.get(self._key(backend, text))

    def set(self, backend: str, text: str, translation: str) -> None:
        with self._lock:
            self._store[self._key(backend, text)] = translation
            self._flush()

    def _flush(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(self._path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self._store, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(self._path)
