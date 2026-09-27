"""Rerank the top of the RRF-fused list using raw PE-Core/BEiT-3 embeddings.

Off by default (Settings.embedding_rerank_enabled) — see src/config.py for
the rationale, including why a text cross-encoder (e.g. a Jina reranker)
was tried and rejected: it cannot see the frame at all, only whatever OCR/
caption/ASR text happens to be attached, which covers a small minority of
frames. This instead combines BOTH encoders' raw cosine similarity for the
full RRF-fused candidate set — a genuine visual signal every candidate has.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

import numpy as np

from src.search.hybrid_search import FusedResult


def fused_result_key(result: FusedResult) -> str:
    """The frame_ids.json / frame_mapping.json key for a fused result.

    See scripts/build_pecore_index_sidecars.py — must match exactly.
    """
    return f"{result.video_id}_{result.frame_id}"


def _cosine_similarities(query_vector: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Dot product, not full cosine — PE-Core/BEiT-3 both encode with
    normalize=True, so vectors are already unit-length and a plain dot
    product IS cosine similarity."""
    return matrix @ query_vector


def rerank_by_embedding_similarity(
    results: Sequence[FusedResult],
    *,
    top_n: int,
    query_pe_core_embedding: Optional[np.ndarray],
    pe_core_vectors: Dict[str, np.ndarray],
    pe_core_weight: float = 1.0,
    query_beit3_embedding: Optional[np.ndarray] = None,
    beit3_vectors: Optional[Dict[str, np.ndarray]] = None,
    beit3_weight: float = 0.0,
    query_siglip2_embedding: Optional[np.ndarray] = None,
    siglip2_vectors: Optional[Dict[str, np.ndarray]] = None,
    siglip2_weight: float = 0.0,
) -> List[FusedResult]:
    """Rerank the top_n RRF results by a combined raw cosine score.

    A candidate missing from ``pe_core_vectors``/``beit3_vectors``/
    ``siglip2_vectors`` (e.g. the caller couldn't reconstruct its vector)
    contributes 0 for that ranker — matching how search_visual_ensemble
    already treats a candidate absent from one ranker's own top_m list,
    rather than dropping the candidate or raising.

    Results beyond top_n keep their RRF order, appended unchanged after the
    reranked head. Mutates and reassigns ``.rank`` to match the new order,
    since callers (SearchEngine._format_results) forward that field as-is.
    """
    if not results or top_n <= 0 or query_pe_core_embedding is None:
        return list(results)

    head = list(results[:top_n])
    tail = list(results[top_n:])
    keys = [fused_result_key(r) for r in head]

    zero_pe_core = np.zeros_like(query_pe_core_embedding)
    pe_core_matrix = np.stack([pe_core_vectors.get(k, zero_pe_core) for k in keys])
    combined = pe_core_weight * _cosine_similarities(
        query_pe_core_embedding, pe_core_matrix
    )

    if query_beit3_embedding is not None and beit3_vectors:
        zero_beit3 = np.zeros_like(query_beit3_embedding)
        beit3_matrix = np.stack([beit3_vectors.get(k, zero_beit3) for k in keys])
        combined = combined + beit3_weight * _cosine_similarities(
            query_beit3_embedding, beit3_matrix
        )

    if query_siglip2_embedding is not None and siglip2_vectors:
        zero_siglip2 = np.zeros_like(query_siglip2_embedding)
        siglip2_matrix = np.stack(
            [siglip2_vectors.get(k, zero_siglip2) for k in keys]
        )
        combined = combined + siglip2_weight * _cosine_similarities(
            query_siglip2_embedding, siglip2_matrix
        )

    order = np.argsort(-combined)
    reranked_head = [head[i] for i in order]

    combined_results = reranked_head + tail
    for rank, r in enumerate(combined_results, start=1):
        r.rank = rank
    return combined_results


__all__ = [
    "fused_result_key",
    "rerank_by_embedding_similarity",
]
