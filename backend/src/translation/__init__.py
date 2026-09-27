"""Vietnamese -> English query translation for the visual retrieval path.

Pluggable by design (mirrors src/encoders): a primary backend (DeepSeek API,
best quality) wrapped by an offline fallback (competition-day safety) and a
file cache (cost/latency). Only the PE-Core/BEiT-3 visual path uses this — the
PhoBERT ASR/OCR paths keep Vietnamese untranslated.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from .base import QueryTranslator, TranslationError
from .cache import TranslationCache
from .composite import CachingTranslator, FallbackTranslator
from .deepseek_translator import DEFAULT_MODEL, DeepSeekTranslator
from .offline_translator import IdentityTranslator, NLLBTranslator

__all__ = [
    "QueryTranslator",
    "TranslationError",
    "TranslationCache",
    "CachingTranslator",
    "FallbackTranslator",
    "DeepSeekTranslator",
    "IdentityTranslator",
    "NLLBTranslator",
    "build_translator",
]


def build_translator(
    *,
    backend: str = "deepseek",
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    cache_path: Optional[Path] = None,
    offline_fallback: str = "identity",
    offline_model: Optional[str] = None,
    device: str = "cpu",
    transport=None,
) -> QueryTranslator:
    """Assemble a translator: primary backend + offline fallback + cache.

    ``backend``: "deepseek" | "nllb" | "identity".
    ``offline_fallback``: "identity" | "nllb" — used only for API backends.
    ``transport``: optional injected HTTP transport for DeepSeek (tests).
    """
    if backend == "deepseek":
        primary: QueryTranslator = DeepSeekTranslator(
            api_key,
            model=model or DEFAULT_MODEL,
            transport=transport,
        )
        fallback = _build_offline(offline_fallback, offline_model, device)
        translator: QueryTranslator = FallbackTranslator(primary, fallback)
    elif backend == "nllb":
        translator = _build_offline("nllb", offline_model, device)
    elif backend == "identity":
        translator = IdentityTranslator()
    else:
        raise ValueError(f"unknown translation backend: {backend!r}")

    if cache_path is not None:
        translator = CachingTranslator(translator, TranslationCache(cache_path))
    return translator


def _build_offline(
    kind: str, model: Optional[str], device: str
) -> QueryTranslator:
    if kind == "identity":
        return IdentityTranslator()
    if kind == "nllb":
        if model:
            return NLLBTranslator(model, device=device)
        return NLLBTranslator(device=device)
    raise ValueError(f"unknown offline fallback: {kind!r}")
