"""Inference-only stub for the unilm beit3 ``utils`` module.

The vendored ``modeling_finetune.py`` imports ``utils`` only for training
(distributed rank helpers and the contrastive ClipLoss). This project uses
BEiT-3 strictly for offline inference, so the stub keeps model construction
working without pulling the full training utility file and its extra
dependencies. Any attempt to actually train fails loudly.
"""
import torch.nn as nn


def get_rank() -> int:
    return 0


def get_world_size() -> int:
    return 1


class ClipLoss(nn.Module):
    def __init__(self, rank: int = 0, world_size: int = 1):
        super().__init__()

    def forward(self, *args, **kwargs):
        raise RuntimeError(
            "This is an inference-only BEiT-3 vendor copy; training via "
            "ClipLoss is not supported. Use the upstream microsoft/unilm "
            "repository for fine-tuning."
        )
