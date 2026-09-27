"""Composable translator wrappers: caching and primary->fallback degradation."""
from __future__ import annotations

from loguru import logger

from .base import QueryTranslator, TranslationError
from .cache import TranslationCache


class CachingTranslator(QueryTranslator):
    """Serve repeated queries from a cache; only call ``inner`` on a miss."""

    def __init__(self, inner: QueryTranslator, cache: TranslationCache):
        self._inner = inner
        self._cache = cache
        self.name = f"cached:{inner.name}"

    def translate(self, text: str) -> str:
        text = text.strip()
        if not text:
            return ""
        cached = self._cache.get(self._inner.name, text)
        if cached is not None:
            return cached
        result = self._inner.translate(text)
        self._cache.set(self._inner.name, text, result)
        return result


class FallbackTranslator(QueryTranslator):
    """Try ``primary``; on :class:`TranslationError`, degrade to ``fallback``.

    Purpose: at competition time an external API (DeepSeek) may be blocked or
    rate-limited. This keeps the visual path alive with an offline backend
    instead of failing the whole query.
    """

    def __init__(self, primary: QueryTranslator, fallback: QueryTranslator):
        self._primary = primary
        self._fallback = fallback
        self.name = f"{primary.name}->{fallback.name}"

    def translate(self, text: str) -> str:
        try:
            return self._primary.translate(text)
        except TranslationError as exc:
            logger.warning(
                f"Translator '{self._primary.name}' failed ({exc}); "
                f"falling back to '{self._fallback.name}'"
            )
            return self._fallback.translate(text)
