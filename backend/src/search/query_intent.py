"""Query-intent classification for modality-aware weighted RRF fusion.

Maps a query to one of a small set of intents (screen-text or speech;
otherwise "default") and returns per-ranker RRF
weight overrides that boost the ranker most likely to carry the answer for
that intent.

NOTE on provenance (corrected 2026-07-26): this is a project-original
heuristic, NOT a port of MMMORRF (SIGIR 2025, arXiv:2503.20698). Verified by
reading the full paper: MMMORRF's weight coefficient is per-VIDEO, computed
once at indexing time from how closely a video resembles broadcast news
footage (via a fixed SigLIP probe query), and it fuses only two groups
(vision vs. a joint OCR+ASR text index) — it does not classify query intent
at all. An earlier research summary mischaracterized it as query-adaptive
keyword routing; that summary was wrong. What's implemented here is a
different, simpler idea in the same "weighted RRF" family (also legitimized
by Bruch et al., SIGIR 2022, on mitigating noisy rankers via weighting): rank
the query into ocr/asr/default by keyword and reweight this project's five
rankers accordingly. Gated off by default in
``Settings.query_adaptive_rrf_enabled`` until validated against labeled
queries (see scripts/ablation_rrf.py).
"""
import re
import unicodedata
from typing import Dict, Set

from src.search.query_utils import normalize_for_search

RANKER_NAMES = ("visual", "audio", "ocr", "caption", "graph")

# Keyword sets are accent-stripped (matched against normalize_for_search
# output), so Vietnamese and English variants share one lookup.
_OCR_KEYWORDS = (
    "chu", "dong chu", "bang hieu", "bien hieu", "van ban", "tieu de",
    "man hinh", "hien thi", "bien bao", "phu de", "ky tu",
    "text", "word", "words", "sign", "caption", "subtitle", "written",
    "label", "logo",
)

_ASR_KEYWORDS = (
    "noi", "loi noi", "giong noi", "phat bieu", "hat", "phat am",
    "loi thoai", "hoi thoai", "am thanh", "nghe thay", "bai hat", "ca si",
    "speech", "say", "saying", "said", "voice", "spoken",
)

# These are deliberately broad, domain-level signals rather than query IDs.
# They are used only for a bounded visual-routing adjustment; the normal
# OCR/ASR intent classifier remains unchanged.
_VISUAL_LAYOUT_KEYWORDS = (
    "slide", "slideshow", "presentation", "powerpoint", "diagram",
    "chart", "graph", "infographic", "illustration", "cartoon",
    "animation", "animated", "comic", "poster", "screen", "man hinh",
    "hoat hinh", "nhan vat 3d", "3d", "three dimensional", "keo co",
)

_VISUAL_TEMPORAL_KEYWORDS = (
    "bat dau", "sau do", "tiep den", "tiep theo", "ket thuc", "truoc do",
    "truoc khi", "chuyen canh", "chuyen sang", "chuyen tiep", "tiep tuc",
    "then", "followed by", "next", "afterwards", "before", "after",
    "finally", "transition", "scene change", "moving from", "pan from",
)

_FROM_TO_RE = re.compile(r"\bfrom\b.+\bto\b")


def _feature_normalize(query: str) -> str:
    """Normalize feature text without relying on the legacy VN map.

    The shared search normalizer is intentionally conservative, but older
    deployments may carry a mojibake Vietnamese accent table.  Specialist
    routing must still recognize markers such as ``sau đó`` and ``chuyển
    cảnh``; NFKD plus an explicit ``đ`` replacement is deterministic and has
    no effect on the actual encoder query.
    """
    text = unicodedata.normalize("NFKD", str(query or "")).lower()
    text = text.replace("đ", "d")
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^\w\s]", " ", text).strip()


def detect_visual_query_features(query: str) -> Set[str]:
    """Return bounded visual-specialist features for a query.

    ``layout`` covers slide/diagram/cartoon-style descriptions where BEiT-3
    often carries a useful single-model signal. ``temporal`` covers explicit
    scene/order language. Matching is accent-insensitive through the shared
    search normalizer and uses token boundaries to avoid substring matches.
    """
    normalized = normalize_for_search(query)
    robust = _feature_normalize(query)
    padded = f" {normalized} {robust} "
    features: Set[str] = set()
    if any(f" {marker} " in padded for marker in _VISUAL_LAYOUT_KEYWORDS):
        features.add("layout")
    if any(f" {marker} " in padded for marker in _VISUAL_TEMPORAL_KEYWORDS):
        features.add("temporal")
    if _FROM_TO_RE.search(normalized) or _FROM_TO_RE.search(robust):
        features.add("temporal")
    return features

_DEFAULT_WEIGHTS: Dict[str, float] = {
    "visual": 1.0,
    "audio": 1.0,
    "ocr": 1.0,
    "caption": 1.0,
    "graph": 1.0,
}

_INTENT_WEIGHTS: Dict[str, Dict[str, float]] = {
    "default": dict(_DEFAULT_WEIGHTS),
    "ocr": {
        "visual": 0.6, "audio": 0.6, "ocr": 3.0, "caption": 0.6,
        "graph": 0.6,
    },
    "asr": {
        "visual": 0.6, "audio": 3.0, "ocr": 0.6, "caption": 0.6,
        "graph": 0.6,
    },
}


def classify_query_intent(query: str) -> str:
    """Classify a query as 'ocr', 'asr', or 'default'.

    Checked in a fixed OCR > ASR priority because on-screen text and speech
    mentions are the two explicitly routed modalities.
    """
    normalized = f" {normalize_for_search(query)} "
    if any(f" {kw} " in normalized for kw in _OCR_KEYWORDS):
        return "ocr"
    if any(f" {kw} " in normalized for kw in _ASR_KEYWORDS):
        return "asr"
    return "default"


def intent_rrf_weights(intent: str) -> Dict[str, float]:
    """Per-ranker RRF weight overrides for the given intent.

    Returns a fresh dict (never the shared table) so callers can't mutate
    the profiles in place.
    """
    if intent not in _INTENT_WEIGHTS:
        raise ValueError(f"unknown query intent {intent!r}")
    return dict(_INTENT_WEIGHTS[intent])
