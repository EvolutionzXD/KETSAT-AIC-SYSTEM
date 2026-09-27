#!/usr/bin/env python3
"""Conservative routing/normalization for Vietnamese ASR queries.

The ASR index contains speech text, not visual metadata.  Explicit
speaker/framing tokens therefore should not force gender/person tokens into
the ASR embedding: those tokens belong to the visual lane.  This module
only removes explicit speaker/framing scaffolding.  It never rewrites a
domain word, invents an object/action/outcome, or contains a query/video-
specific rule.  Word-level correction can be added later through an audited
external lexicon, but is intentionally disabled here.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class AsrQueryVariant:
    """One deterministic ASR query and its routing role."""

    text: str
    role: str


_SPEAKER_NOUN = (
    r"(?:người\s+phụ\s+nữ|người\s+đàn\s+ông|người\s+nam|"
    r"cô\s+gái|cậu\s+bé|một\s+người)"
)

# Only remove an explicit visual/speaker wrapper.  Bare "nói về" is kept,
# because it can itself be part of the speech transcript and removing it
# would be more aggressive than necessary.
_SPEAKER_PREFIXES = (
    re.compile(
        rf"\b{_SPEAKER_NOUN}\s+(?:đang\s+)?"
        r"(?:nói|nói\s+chuyện|trình\s+bày|giảng(?:\s+giải)?|"
        r"thuyết\s+trình)\s+(?:về|rằng)\s+",
        flags=re.IGNORECASE,
    ),
    re.compile(
        rf"\b{_SPEAKER_NOUN}\s+đang\s+",
        flags=re.IGNORECASE,
    ),
)

def _clean(text: str) -> str:
    text = unicodedata.normalize("NFC", str(text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text


def normalize_asr_query(text: str) -> str:
    """Canonicalize Unicode/whitespace without changing vocabulary."""
    return _clean(text)


def strip_visual_speaker_scaffolding(text: str) -> str:
    """Remove explicit visual speaker wrappers, preserving content words."""
    value = _clean(text)
    for pattern in _SPEAKER_PREFIXES:
        value = pattern.sub("", value, count=1)
    return _clean(value)


def build_asr_query_variants(text: str, max_variants: int = 3) -> List[AsrQueryVariant]:
    """Build a bounded, deterministic ASR query plan.

    The first variant is the content query when a visual/speaker wrapper was
    detected.  The original query is retained only as a low-priority fallback
    so a legitimate phrase is never discarded.  For ordinary clean queries
    this returns one item, preserving the old latency and ranking behavior.
    """
    original = _clean(text)
    if not original:
        return []
    normalized = normalize_asr_query(original)
    content = strip_visual_speaker_scaffolding(normalized)

    candidates = []

    def add(value: str, role: str) -> None:
        value = _clean(value)
        if not value or any(v.text.casefold() == value.casefold()
                            for v in candidates):
            return
        candidates.append(AsrQueryVariant(value, role))

    if content != normalized:
        add(content, "content")
    if normalized != original:
        add(normalized, "normalized")
    # Keep the original only when a rewrite occurred; it is a fallback, not
    # the primary ASR embedding because it may contain wrong visual details.
    if content != original:
        add(original, "original_fallback")
    if not candidates:
        add(original, "original")
    return candidates[: max(1, int(max_variants))]
