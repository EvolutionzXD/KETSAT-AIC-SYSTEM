"""Visual verification of text-modality (OCR/ASR/caption) candidates.

Off by default (Settings.cascade_verification_enabled). Implements the
verification half of the user's cascade proposal (2026-08-14): a candidate
that RRF only ranked because of OCR/ASR/caption text has no guarantee its
frame actually shows the queried scene — those modalities score segment
text, not pixels. This reconstructs the SAME frame's already-indexed
PE-Core/BEiT-3 vectors (via ResourceManager.get_frame_key_near +
get_pe_core_vector/get_beit3_vector — no JPEGs needed, see those
docstrings) and nudges the candidate's rrf_score by raw cosine agreement
with the query: a corroborating frame gets a modest boost, a contradicting
one a heavier penalty. A candidate the visual encoders already found on
their own (visual_score > 0) is left untouched — it doesn't need text-
sourced verification.

Evaluated 2026-08-15 against 27 real ground-truth queries
(reports/manual_*query_test_batch1_20260810/): baseline RRF recall@5 was
9/27 (0.333); this cascade at the values below reached 10/27 (0.370) with
no query regressing below its baseline recall@5 hit/miss status. Small
sample, one query's rank flip drives most of the delta — worth widening
the eval before trusting the exact numbers, but the direction is
consistently non-negative across the threshold grid that was swept
(sweep script was ad hoc this session, not checked in). The dominant
remaining gap
was retrieval coverage (11/27 queries never appeared in the RRF top-20 at
all) which this rerank cannot fix — it only reorders what already made
the candidate list.
"""
from __future__ import annotations

from typing import List, Optional

import numpy as np

from src.search.hybrid_search import FusedResult


def _cosine(query_vector: np.ndarray, frame_vector: np.ndarray) -> float:
    denom = np.linalg.norm(query_vector) * np.linalg.norm(frame_vector)
    if denom == 0:
        return 0.0
    return float(np.dot(query_vector, frame_vector) / denom)


def apply_cascade_verification(
    results: List[FusedResult],
    *,
    rm,
    query_pe_core_embedding: Optional[np.ndarray],
    query_beit3_embedding: Optional[np.ndarray] = None,
    agree_threshold: float = 0.30,
    disagree_threshold: float = 0.15,
    boost_weight: float = 0.15,
    penalty: float = 0.3,
) -> List[FusedResult]:
    """Re-rank text-sourced candidates by raw visual agreement.

    Mutates and reassigns `.rank` on a re-sorted copy, matching
    rerank_by_embedding_similarity's contract so callers can chain it the
    same way. A candidate whose frame has no snappable visual vector (rare —
    only if a video is entirely missing from frame_mapping) keeps its
    original rrf_score, neither boosted nor penalized.
    """
    if not results or query_pe_core_embedding is None:
        return list(results)

    adjusted = []
    for r in results:
        has_text_modality = r.caption_score > 0 or r.ocr_score > 0 or r.audio_score > 0
        if not has_text_modality or r.visual_score > 0:
            adjusted.append((r.rrf_score, r))
            continue

        key = rm.get_frame_key_near(r.video_id, r.frame_id)
        if key is None:
            adjusted.append((r.rrf_score, r))
            continue

        sims = []
        pe_vec = rm.get_pe_core_vector(key)
        if pe_vec is not None:
            sims.append(_cosine(query_pe_core_embedding, pe_vec))
        if query_beit3_embedding is not None:
            beit3_vec = rm.get_beit3_vector(key)
            if beit3_vec is not None:
                sims.append(_cosine(query_beit3_embedding, beit3_vec))

        if not sims:
            adjusted.append((r.rrf_score, r))
            continue

        visual_sim = sum(sims) / len(sims)
        if visual_sim >= agree_threshold:
            new_score = r.rrf_score + boost_weight * visual_sim
        elif visual_sim < disagree_threshold:
            new_score = r.rrf_score - penalty
        else:
            new_score = r.rrf_score
        adjusted.append((new_score, r))

    adjusted.sort(key=lambda pair: -pair[0])
    reordered = [r for _, r in adjusted]
    for rank, r in enumerate(reordered, start=1):
        r.rank = rank
    return reordered


__all__ = ["apply_cascade_verification"]
