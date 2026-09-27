"""Read/write/validate the ``index_metadata.json`` sidecar for FAISS indexes.

The sidecar records which encoder produced an index so query-time code can
detect backbone mismatches (e.g. a 512-d ViT-B/32 index queried with a
1280-d bigG text encoder) instead of failing with an opaque FAISS error.
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

INDEX_METADATA_FILENAME = "index_metadata.json"
INDEX_METADATA_SCHEMA_VERSION = 1


def write_index_metadata(
    index_dir: Path,
    encoder_type: str,
    checkpoint: str,
    embedding_dim: int,
    normalized: bool,
    frame_count: int,
    candidate_sampling: Optional[str] = None,
) -> Path:
    """Write the sidecar next to the index files and return its path."""
    metadata = {
        "schema_version": INDEX_METADATA_SCHEMA_VERSION,
        "encoder_type": encoder_type,
        "checkpoint": checkpoint,
        "embedding_dim": embedding_dim,
        "normalized": normalized,
        "frame_count": frame_count,
        "candidate_sampling": candidate_sampling,
    }
    index_dir.mkdir(parents=True, exist_ok=True)
    path = index_dir / INDEX_METADATA_FILENAME
    with open(path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    return path


def load_index_metadata(index_dir: Path) -> Optional[Dict[str, Any]]:
    """Load the sidecar if present; return None for legacy indexes."""
    path = index_dir / INDEX_METADATA_FILENAME
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def check_index_metadata(
    metadata: Dict[str, Any],
    index_dim: int,
    expected_checkpoint: Optional[str] = None,
    expected_encoder_type: Optional[str] = None,
) -> List[str]:
    """Return a list of human-readable mismatch problems (empty = OK)."""
    problems: List[str] = []
    meta_dim = metadata.get("embedding_dim")
    if meta_dim is not None and meta_dim != index_dim:
        problems.append(
            f"index dimension {index_dim} does not match metadata "
            f"embedding_dim {meta_dim}"
        )
    meta_ckpt = metadata.get("checkpoint")
    if (
        expected_checkpoint is not None
        and meta_ckpt is not None
        and meta_ckpt != expected_checkpoint
    ):
        problems.append(
            f"index was built with checkpoint '{meta_ckpt}' but the "
            f"configured query encoder is '{expected_checkpoint}'"
        )
    meta_encoder_type = metadata.get("encoder_type")
    if (
        expected_encoder_type is not None
        and meta_encoder_type != expected_encoder_type
    ):
        problems.append(
            f"index encoder_type is '{meta_encoder_type}' but "
            f"'{expected_encoder_type}' is required"
        )
    return problems
