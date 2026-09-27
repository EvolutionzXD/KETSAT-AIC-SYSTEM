"""Temporal grounding backbones (UniversalVTG prototype)."""
from src.grounding.base import TemporalGrounder, TemporalSegment
from src.grounding.universalvtg_adapter import UniversalVTGGrounder

__all__ = ["TemporalGrounder", "TemporalSegment", "UniversalVTGGrounder"]
