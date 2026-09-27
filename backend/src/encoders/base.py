"""Abstract visual-text encoder interface.

Every first-stage retrieval backbone (PE-Core and BEiT-3) implements
this contract so feature extraction, index building, and query-time search
can swap backbones without touching pipeline code.
"""
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Sequence

import numpy as np


class VisualTextEncoder(ABC):
    """Dual encoder mapping images and texts into one shared embedding space.

    Contract:
    - ``encode_images`` / ``encode_texts`` return float32 arrays of shape
      ``(N, embedding_dim)``.
    - Rows are L2-normalized when ``normalized`` is True (the default), so
      inner product equals cosine similarity and matches ``IndexFlatIP``.
    """

    #: Short stable identifier, e.g. "pe_core", "beit3". Used in index metadata.
    encoder_type: str = "base"

    @abstractmethod
    def encode_images(self, images: Sequence[Any]) -> np.ndarray:
        """Encode a batch of PIL images into ``(N, embedding_dim)`` float32."""

    @abstractmethod
    def encode_texts(self, texts: Sequence[str]) -> np.ndarray:
        """Encode a batch of texts into ``(N, embedding_dim)`` float32."""

    @property
    @abstractmethod
    def embedding_dim(self) -> int:
        """Output embedding dimension. Never hardcode at call sites."""

    @property
    @abstractmethod
    def checkpoint(self) -> str:
        """Model name or local path identifying the exact weights."""

    @property
    def normalized(self) -> bool:
        """Whether output embeddings are L2-normalized."""
        return True

    def metadata(self) -> Dict[str, Any]:
        """Serializable description for index/feature provenance."""
        return {
            "encoder_type": self.encoder_type,
            "checkpoint": self.checkpoint,
            "embedding_dim": self.embedding_dim,
            "normalized": self.normalized,
        }
