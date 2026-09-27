"""Dense, field-aware retrieval over Qwen structured event records."""
from __future__ import annotations

from typing import Callable, Dict, List, Tuple

import faiss
import numpy as np

from src.search.caption_search import CaptionHit


FIELD_WEIGHTS = {
    "visual_description": 1.0,
    "actions": 0.9,
    "entities": 0.7,
}


def search_structured_caption_records(
    query_embedding: np.ndarray,
    resources: Dict[str, Tuple[faiss.Index, List[dict]]],
    *,
    fps_lookup: Callable[[str], float],
    top_k: int = 30,
    top_k_per_field: int = 90,
    rrf_k: int = 60,
) -> List[CaptionHit]:
    """Search each populated Qwen field, then fuse by event ``record_id``.

    Raw cosine values are deliberately not added across fields. Weighted RRF
    makes action/entity agreement useful without assuming their score scales
    are calibrated to visual-description scores.
    """
    vector = np.asarray(query_embedding, dtype=np.float32).copy()
    if vector.ndim == 1:
        vector = vector.reshape(1, -1)
    faiss.normalize_L2(vector)

    fused = {}
    for field, weight in FIELD_WEIGHTS.items():
        resource = resources.get(field)
        if resource is None:
            continue
        index, rows = resource
        count = min(top_k_per_field, index.ntotal)
        scores, ids = index.search(vector, count)
        for rank, (row_id, similarity) in enumerate(zip(ids[0], scores[0]), 1):
            if row_id < 0:
                continue
            row = rows[int(row_id)]
            record_id = row["record_id"]
            item = fused.setdefault(
                record_id,
                {
                    "row": row,
                    "rrf": 0.0,
                    "max_similarity": float("-inf"),
                    "snippets": {},
                },
            )
            item["rrf"] += weight / (rrf_k + rank)
            item["max_similarity"] = max(item["max_similarity"], float(similarity))
            item["snippets"][field] = row.get("text", "")

    ranked = sorted(
        fused.values(),
        key=lambda item: (-item["rrf"], item["row"]["record_id"]),
    )[:top_k]
    hits = []
    for item in ranked:
        row = item["row"]
        video_id = row["video_id"]
        start_seconds = float(row.get("start_seconds", 0.0))
        snippets = item["snippets"]
        snippet = snippets.get("visual_description") or snippets.get("actions") or snippets.get("entities", "")
        hits.append(
            CaptionHit(
                record_id=row["record_id"],
                video_id=video_id,
                frame_id=int(start_seconds * fps_lookup(video_id)),
                score=item["max_similarity"],
                text_snippet=snippet,
                start_seconds=start_seconds,
                end_seconds=float(row.get("end_seconds", start_seconds)),
            )
        )
    return hits
