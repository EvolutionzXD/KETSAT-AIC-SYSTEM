"""Keyword search over Qwen semantic-record captions.

Each record covers a KCP window — a ``[start_seconds, end_seconds)`` time
RANGE, not a single frame — described in six structured fields
(``visual_description``, ``actions``, ``scene``, ``visible_text``,
``spoken_summary``, ``entities``) rather than one caption string. This is a
separate module, not a method on ``HybridSearchEngine``, because that class
is frame-indexed throughout (``SearchSignal.frame_id: int``) and importing
its types here would risk a circular import the other way; ``dual_query_temporal.py``
uses the same standalone-module pattern for the same reason.

``frame_id`` on the returned hit is the window's START converted with the
video's real fps — the same convention ``search_audio`` already uses for
ASR segments, which have the identical range-not-frame shape. This lets a
window-level result plug into the existing frame-indexed RRF fusion without
changing it; a consumer that wants the real window has ``start_seconds`` /
``end_seconds`` on the hit rather than having to re-derive it from
``frame_id``.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Set, Tuple

from src.search.query_utils import extract_keywords, normalize_for_search

FpsLookup = Callable[[str], float]

_SCHEMA_TEXT_FIELDS = ("visual_description", "scene", "spoken_summary")
_SCHEMA_LIST_FIELDS = ("actions", "visible_text", "entities")


@dataclass(frozen=True)
class CaptionHit:
    """One matched record, ranked by IDF-weighted keyword overlap with the query."""

    record_id: str
    video_id: str
    frame_id: int
    score: float
    text_snippet: str
    start_seconds: float
    end_seconds: float


@dataclass
class CaptionSearchIndex:
    """Corpus-level IDF index, built once per loaded caption corpus.

    Mirrors ``src/search/ocr_scoring.py``'s ``OCRSearchIndex`` — same reason:
    plain keyword-count overlap scores a caption containing only "woman" the
    same as one containing "checkered scarf", so generic-word captions
    outrank or crowd out the one genuinely distinctive match. IDF (rarer
    across the corpus -> higher weight) fixes that without touching how
    captions are generated.
    """

    docs: Dict[str, Tuple[dict, Set[str]]]
    idf: Dict[str, float]
    num_docs: int


def _joined_text(record: dict) -> str:
    parts = [str(record.get(field, "")) for field in _SCHEMA_TEXT_FIELDS]
    for field in _SCHEMA_LIST_FIELDS:
        parts.extend(str(item) for item in record.get(field, []) or [])
    return " ".join(part for part in parts if part)


def build_caption_index(records: Dict[str, dict]) -> CaptionSearchIndex:
    """Build the searchable IDF index once per loaded caption corpus."""
    docs: Dict[str, Tuple[dict, Set[str]]] = {}
    token_to_docs: Dict[str, Set[str]] = {}
    for record_id, entry in records.items():
        parsed = entry.get("record")
        if not parsed:
            continue
        tokens = set(normalize_for_search(_joined_text(parsed)).split())
        docs[record_id] = (entry, tokens)
        for token in tokens:
            token_to_docs.setdefault(token, set()).add(record_id)

    num_docs = max(len(docs), 1)
    idf = {
        token: math.log((num_docs + 1) / (len(doc_ids) + 1))
        for token, doc_ids in token_to_docs.items()
    }
    return CaptionSearchIndex(docs=docs, idf=idf, num_docs=num_docs)


def search_caption_records(
    query_text: str,
    records: Dict[str, dict],
    *,
    fps_lookup: FpsLookup,
    top_k: int = 30,
    index: Optional[CaptionSearchIndex] = None,
) -> List[CaptionHit]:
    """Rank records by IDF-weighted keyword overlap between the query and
    all 6 fields.

    ``index`` should be built once per loaded corpus with
    ``build_caption_index`` and reused across queries (see
    ``HybridSearchEngine.search_caption``'s cache) — rebuilding it here on
    every call still works (kept as the default for callers that only ever
    run one query, e.g. tests) but costs a full corpus scan each time.

    Score is the fraction of the query's *achievable IDF mass* that this
    record matched (0-1), not a raw overlap count: a record matching one
    rare token can outscore one matching several corpus-common tokens,
    which plain overlap could not express. Records with ``record`` set to
    ``None`` — Qwen output whose JSON could not be parsed or repaired,
    ~1.5% of the real corpus — are skipped rather than raised on: this is
    one signal fused with several others, so a crash here would take every
    modality down with it.
    """
    query_keywords = set(extract_keywords(normalize_for_search(query_text)))
    if not query_keywords:
        return []

    if index is None:
        index = build_caption_index(records)

    max_idf_mass = sum(index.idf.get(token, 0.0) for token in query_keywords)
    if max_idf_mass <= 0:
        return []

    scored = []
    for record_id, (entry, tokens) in index.docs.items():
        overlap = query_keywords & tokens
        if not overlap:
            continue
        idf_mass = sum(index.idf.get(token, 0.0) for token in overlap)
        if idf_mass <= 0:
            continue
        scored.append((entry, idf_mass / max_idf_mass))

    # Tie-break on record_id so identical queries always return the same
    # order — an unstable sort would make top_k selection flap between runs.
    scored.sort(key=lambda pair: (-pair[1], pair[0].get("record_id", "")))

    hits: List[CaptionHit] = []
    for entry, score in scored[:top_k]:
        video_id = entry["video_id"]
        start_seconds = float(entry.get("start_seconds", 0.0))
        hits.append(
            CaptionHit(
                record_id=entry.get("record_id", ""),
                video_id=video_id,
                frame_id=int(start_seconds * fps_lookup(video_id)),
                score=score,
                text_snippet=str(entry["record"].get("visual_description", "")),
                start_seconds=start_seconds,
                end_seconds=float(entry.get("end_seconds", start_seconds)),
            )
        )
    return hits
