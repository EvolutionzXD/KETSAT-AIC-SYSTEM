"""Visual-text encoder backbones used by the AIC 2026 pipeline."""
from src.encoders.base import VisualTextEncoder
from src.encoders.beit3_encoder import BEiT3Encoder
from src.encoders.index_metadata import (
    INDEX_METADATA_FILENAME,
    check_index_metadata,
    load_index_metadata,
    write_index_metadata,
)
from src.encoders.pe_core_encoder import DEFAULT_PE_CORE_MODEL_ID, PECoreEncoder
from src.encoders.jina_v5_omni_encoder import (
    DEFAULT_JINA_V5_OMNI_MODEL_ID,
    JinaV5OmniEncoder,
)
from src.encoders.siglip2_encoder import (
    DEFAULT_SIGLIP2_MODEL_ID,
    DEFAULT_SIGLIP2_PRETRAINED,
    SigLIP2Encoder,
)

__all__ = [
    "VisualTextEncoder",
    "BEiT3Encoder",
    "PECoreEncoder",
    "DEFAULT_PE_CORE_MODEL_ID",
    "JinaV5OmniEncoder",
    "DEFAULT_JINA_V5_OMNI_MODEL_ID",
    "SigLIP2Encoder",
    "DEFAULT_SIGLIP2_MODEL_ID",
    "DEFAULT_SIGLIP2_PRETRAINED",
    "INDEX_METADATA_FILENAME",
    "check_index_metadata",
    "load_index_metadata",
    "write_index_metadata",
]
