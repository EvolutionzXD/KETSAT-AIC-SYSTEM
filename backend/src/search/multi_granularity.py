"""Multi-granularity ensemble search (Algorithm 3 of arXiv:2504.08384).

The active pipeline combines a broad model (PE-Core) and a fine
model (BEiT-3) by MAX-NORMALIZED WEIGHTED SCORE FUSION — not RRF:

    score_dict[i] += (s / S_max) * w      with   sum(w) = 1

Each model retrieves top-M (default 50) hits; every model's scores are scaled
by that model's own maximum so the two granularities are comparable before the
weighted sum. This is deliberately different from the pipeline's RRF (which
fuses cross-modal signals) — here we fuse two visual granularities exactly as
the paper specifies, so the baseline is reproducible and comparable to RRF.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

# (item_id, score) ranked descending — one model's retrieval output.
ScoredHit = Tuple[str, float]

DEFAULT_TOP_M = 50
DEFAULT_TOP_K = 100


def normalize_weights(
    models: Sequence[str], weights: Optional[Mapping[str, float]]
) -> Dict[str, float]:
    """Return per-model weights summing to 1 (equal weights when unspecified)."""
    if not models:
        raise ValueError("at least one model is required")
    if weights is None:
        equal = 1.0 / len(models)
        return {model: equal for model in models}

    missing = [m for m in models if m not in weights]
    if missing:
        raise ValueError(f"weights missing for models: {missing}")
    selected = {m: float(weights[m]) for m in models}
    if any(w < 0 for w in selected.values()):
        raise ValueError("weights must be non-negative")
    total = sum(selected.values())
    if total <= 0:
        raise ValueError("weights must sum to a positive value")
    return {m: w / total for m, w in selected.items()}


def normalized_score_fusion(
    model_results: Mapping[str, Sequence[ScoredHit]],
    *,
    weights: Optional[Mapping[str, float]] = None,
    top_m: int = DEFAULT_TOP_M,
    top_k: int = DEFAULT_TOP_K,
) -> List[ScoredHit]:
    """Fuse per-model ranked hits into one ranking (paper Algorithm 3).

    ``model_results`` maps model name -> its ranked ``(item_id, score)`` hits.
    Each model contributes its top-``top_m`` hits, scaled by that model's max
    score and its normalized weight. Returns the top-``top_k`` fused hits,
    sorted by aggregated score (deterministic id tie-break).
    """
    if top_m <= 0:
        raise ValueError("top_m must be positive")
    if top_k <= 0:
        raise ValueError("top_k must be positive")
    if not model_results:
        raise ValueError("model_results must contain at least one model")

    models = list(model_results.keys())
    resolved_weights = normalize_weights(models, weights)

    aggregated: Dict[str, float] = defaultdict(float)
    for model in models:
        hits = list(model_results[model])[:top_m]
        if not hits:
            continue
        max_score = max(score for _, score in hits)
        # Guard: cosine/IP scores can be <= 0; avoid divide-by-zero and sign
        # flips by only normalizing when the max is a positive scale.
        denominator = max_score if max_score > 0 else 1.0
        weight = resolved_weights[model]
        for item_id, score in hits:
            aggregated[item_id] += (score / denominator) * weight

    ranked = sorted(aggregated.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranked[:top_k]
