"""Query translation contracts.

Translation is applied ONLY to the cross-modal visual path (PE-Core/BEiT-3 text
tower is English-aligned). The Vietnamese text paths (PhoBERT over ASR/OCR)
must NOT be translated — they match Vietnamese query against Vietnamese text.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Sequence


class TranslationError(RuntimeError):
    """A translator backend failed to produce a translation."""


class QueryTranslator(ABC):
    """Vietnamese -> English query translator for the visual retrieval path."""

    name: str = "base"
    target_language: str = "en"

    @abstractmethod
    def translate(self, text: str) -> str:
        """Return the English translation of a single query.

        Implementations raise :class:`TranslationError` on failure so callers
        (e.g. :class:`FallbackTranslator`) can degrade gracefully.
        """

    def translate_batch(self, texts: Sequence[str]) -> List[str]:
        """Translate many queries. Default is per-item; override to batch."""
        return [self.translate(text) for text in texts]
