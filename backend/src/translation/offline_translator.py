"""Offline / no-network translators for the competition-day fallback path.

``IdentityTranslator`` is the guaranteed-available last resort: it never fails,
so the pipeline keeps running even with no network and no models. ``NLLBTranslator``
is the real offline Vietnamese->English option (facebook/nllb-200), loaded lazily.

NLLBTranslator is written from the documented NLLB API but is NOT yet verified
against a live model run here — treat its first real use as a smoke test.
"""
from __future__ import annotations

from .base import QueryTranslator, TranslationError


class IdentityTranslator(QueryTranslator):
    """Pass the query through unchanged.

    A weak translation (the Vietnamese text still reaches the PE-Core
    tower), but it guarantees the pipeline never crashes on translation — the
    right last-resort fallback behind a real backend.
    """

    name = "identity"

    def translate(self, text: str) -> str:
        return text.strip()


class NLLBTranslator(QueryTranslator):
    """Offline Vietnamese->English via NLLB-200. Loaded lazily on first use."""

    name = "nllb"

    def __init__(
        self,
        model_name: str = "facebook/nllb-200-distilled-600M",
        *,
        device: str = "cpu",
        src_lang: str = "vie_Latn",
        tgt_lang: str = "eng_Latn",
        max_length: int = 128,
    ):
        self._model_name = model_name
        self._device = device
        self._src_lang = src_lang
        self._tgt_lang = tgt_lang
        self._max_length = max_length
        self._model = None
        self._tokenizer = None

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        try:
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        except ImportError as exc:
            raise TranslationError(
                "transformers is required for NLLBTranslator"
            ) from exc
        self._tokenizer = AutoTokenizer.from_pretrained(
            self._model_name, src_lang=self._src_lang
        )
        self._model = AutoModelForSeq2SeqLM.from_pretrained(self._model_name).to(
            self._device
        )

    def translate(self, text: str) -> str:
        text = text.strip()
        if not text:
            return ""
        self._ensure_loaded()
        import torch

        inputs = self._tokenizer(text, return_tensors="pt").to(self._device)
        target_id = self._tokenizer.convert_tokens_to_ids(self._tgt_lang)
        with torch.no_grad():
            generated = self._model.generate(
                **inputs,
                forced_bos_token_id=target_id,
                max_length=self._max_length,
            )
        decoded = self._tokenizer.batch_decode(
            generated, skip_special_tokens=True
        )
        return decoded[0].strip() if decoded else ""
