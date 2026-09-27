"""BEiT-3 retrieval implementation of :class:`VisualTextEncoder`.

Wraps the vendored unilm ``BEiT3ForRetrieval`` dual encoder (see
``beit3_vendor/LICENSE_NOTICE.md``). Heavy dependencies (torchscale, timm,
sentencepiece) are imported lazily inside :meth:`_load`, so importing this
module — or ``src.encoders`` — never requires them.

The checkpoint (.pth) and sentencepiece tokenizer (beit3.spm) are never
downloaded automatically; obtain them per the unilm README and pass local
paths explicitly.
"""
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np
import torch
from loguru import logger

from src.encoders.base import VisualTextEncoder

_VENDOR_DIR = Path(__file__).parent / "beit3_vendor"

#: BEiT-3 finetuning uses Inception-style normalization, not ImageNet's.
BEIT3_IMAGE_MEAN = (0.5, 0.5, 0.5)
BEIT3_IMAGE_STD = (0.5, 0.5, 0.5)

RESEARCH_MODEL_NAME = "beit3_large_patch16_224_retrieval"


class LoRADelta(torch.nn.Module):
    """LoRA adapter matching the MSVB BEiT-3 ERM training code exactly."""

    def __init__(
        self,
        in_features: int,
        out_features: int,
        *,
        rank: int,
        alpha: float,
        strength: float,
    ):
        super().__init__()
        self.scale = (alpha / rank) * strength
        self.A = torch.nn.Parameter(torch.empty(rank, in_features))
        self.B = torch.nn.Parameter(torch.empty(out_features, rank))

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return (value @ self.A.t() @ self.B.t()) * self.scale


def attach_research_lora(
    model: torch.nn.Module,
    checkpoint_path: Path,
    *,
    strength: float = 1.0,
) -> int:
    """Attach the image-branch q/v LoRA adapters and load them strictly."""
    try:
        checkpoint = torch.load(
            str(checkpoint_path), map_location="cpu", weights_only=True
        )
    except TypeError:  # PyTorch versions before weights_only support.
        checkpoint = torch.load(str(checkpoint_path), map_location="cpu")

    if not isinstance(checkpoint, dict) or not isinstance(
        checkpoint.get("lora"), dict
    ):
        raise RuntimeError(
            f"invalid BEiT-3 ERM-LoRA checkpoint: {checkpoint_path}"
        )
    rank = int(checkpoint.get("r", 8))
    alpha = float(checkpoint.get("alpha", 16))
    state = checkpoint["lora"]

    targets = [
        (name, module)
        for name, module in model.named_modules()
        if isinstance(module, torch.nn.Linear)
        and name.split(".")[-1:] == ["A"]
        and len(name.split(".")) >= 2
        and name.split(".")[-2] in ("q_proj", "v_proj")
    ]
    target_names = {name for name, _ in targets}
    state_names = set(state)
    if target_names != state_names:
        missing = sorted(target_names - state_names)
        unexpected = sorted(state_names - target_names)
        raise RuntimeError(
            "BEiT-3 ERM-LoRA/model mismatch: "
            f"missing={missing[:5]}, unexpected={unexpected[:5]}"
        )

    for name, module in targets:
        adapter = LoRADelta(
            module.in_features,
            module.out_features,
            rank=rank,
            alpha=alpha,
            strength=strength,
        )
        adapter.A.data.copy_(state[name]["A"])
        adapter.B.data.copy_(state[name]["B"])
        module.add_module("_lora", adapter)

        def hook(current_module, inputs, output):
            return output + current_module._lora(inputs[0])

        module.register_forward_hook(hook)

    if len(targets) != 48:
        raise RuntimeError(
            f"research BEiT-3 large must expose 48 q/v adapters, got {len(targets)}"
        )
    return len(targets)


class BEiT3Encoder(VisualTextEncoder):
    """Lazy-loading BEiT-3 dual encoder for image-text retrieval."""

    encoder_type = "beit3"

    def __init__(
        self,
        checkpoint_path: Path,
        spm_path: Path,
        model_name: str = RESEARCH_MODEL_NAME,
        lora_checkpoint_path: Optional[Path] = None,
        lora_strength: float = 1.0,
        require_lora: bool = False,
        device: Optional[torch.device] = None,
        fp16: bool = False,
        max_text_len: int = 64,
    ):
        checkpoint_path = Path(checkpoint_path)
        spm_path = Path(spm_path)
        if not checkpoint_path.is_file():
            raise FileNotFoundError(
                f"BEiT-3 checkpoint not found: {checkpoint_path}. Download a "
                "*_retrieval.pth checkpoint per the microsoft/unilm beit3 README."
            )
        if not spm_path.is_file():
            raise FileNotFoundError(
                f"BEiT-3 sentencepiece model not found: {spm_path}. Download "
                "beit3.spm per the microsoft/unilm beit3 README."
            )
        if lora_checkpoint_path is not None:
            lora_checkpoint_path = Path(lora_checkpoint_path)
            if not lora_checkpoint_path.is_file():
                raise FileNotFoundError(
                    f"BEiT-3 ERM-LoRA checkpoint not found: {lora_checkpoint_path}"
                )
        if require_lora and lora_checkpoint_path is None:
            raise ValueError(
                "lora_checkpoint_path is required: production BEiT-3 uses "
                "the research ERM-LoRA adapter"
            )
        if lora_strength < 0:
            raise ValueError("lora_strength must be non-negative")
        if "_retrieval" not in model_name:
            raise ValueError(
                f"model_name '{model_name}' is not a retrieval head; only "
                "*_retrieval variants produce a shared image-text space"
            )
        if max_text_len <= 0:
            raise ValueError("max_text_len must be positive")

        self._checkpoint_path = checkpoint_path
        self._spm_path = spm_path
        self._model_name = model_name
        self._lora_checkpoint_path = lora_checkpoint_path
        self._lora_strength = float(lora_strength)
        self._device = device or torch.device(
            "cuda" if torch.cuda.is_available() else "cpu"
        )
        self._fp16 = fp16
        self._max_text_len = max_text_len
        self._model = None
        self._tokenizer = None
        self._transform = None
        self._embedding_dim: Optional[int] = None

    @property
    def checkpoint(self) -> str:
        return self.checkpoint_identity(
            model_name=self._model_name,
            checkpoint_path=self._checkpoint_path,
            lora_checkpoint_path=self._lora_checkpoint_path,
            lora_strength=self._lora_strength,
        )

    @staticmethod
    def checkpoint_identity(
        *,
        model_name: str,
        checkpoint_path: Path,
        lora_checkpoint_path: Optional[Path],
        lora_strength: float,
    ) -> str:
        if lora_checkpoint_path is None:
            return str(checkpoint_path)
        return (
            f"{model_name}|base={checkpoint_path}|"
            f"lora={lora_checkpoint_path}|strength={lora_strength:g}"
        )

    @property
    def embedding_dim(self) -> int:
        self._load()
        return self._embedding_dim

    @property
    def image_size(self) -> int:
        """Input resolution parsed from the model name (e.g. ..._384_...)."""
        for token in self._model_name.split("_"):
            if token.isdigit():
                return int(token)
        raise ValueError(
            f"cannot parse image size from model_name '{self._model_name}'"
        )

    def _load(self) -> None:
        if self._model is not None:
            return

        try:
            from timm.models import create_model
            from torchvision import transforms
            from transformers import XLMRobertaTokenizer
        except ImportError as e:
            raise ImportError(
                f"BEiT-3 dependencies missing ({e}). Install them with: "
                "pip install -r requirements-beit3.txt"
            ) from e

        # The vendored unilm modules use flat absolute imports.
        vendor_dir = str(_VENDOR_DIR)
        if vendor_dir not in sys.path:
            sys.path.insert(0, vendor_dir)
        import modeling_finetune  # noqa: F401  (registers beit3_* with timm)

        logger.info(
            f"Loading BEiT-3 model '{self._model_name}' from "
            f"{self._checkpoint_path}"
        )
        model = create_model(self._model_name)
        state = torch.load(
            str(self._checkpoint_path), map_location="cpu", weights_only=False
        )
        state = state.get("model", state) if isinstance(state, dict) else state
        missing, unexpected = model.load_state_dict(state, strict=False)
        missing = [k for k in missing if not k.startswith("criterion.")]
        if missing or unexpected:
            raise RuntimeError(
                f"BEiT-3 checkpoint does not match model '{self._model_name}': "
                f"missing={missing[:5]}, unexpected={unexpected[:5]}. "
                "Check that the checkpoint is the matching *_retrieval.pth."
            )
        if self._lora_checkpoint_path is not None:
            adapter_count = attach_research_lora(
                model,
                self._lora_checkpoint_path,
                strength=self._lora_strength,
            )
            logger.info(
                f"Loaded research ERM-LoRA from {self._lora_checkpoint_path}; "
                f"adapters={adapter_count}, strength={self._lora_strength:g}"
            )
        if self._fp16:
            # Convert on CPU first. Moving the FP32 model to CUDA and only
            # then halving it temporarily needs about twice the intended
            # VRAM and can OOM on an otherwise sufficient device.
            model = model.half()
        model = model.to(self._device)
        model.eval()

        size = self.image_size
        self._transform = transforms.Compose(
            [
                transforms.Resize(
                    (size, size),
                    interpolation=transforms.InterpolationMode.BICUBIC,
                ),
                transforms.ToTensor(),
                transforms.Normalize(BEIT3_IMAGE_MEAN, BEIT3_IMAGE_STD),
            ]
        )
        self._tokenizer = XLMRobertaTokenizer(str(self._spm_path))
        self._model = model
        self._embedding_dim = int(model.vision_head.out_features)
        logger.info(
            f"BEiT-3 loaded on {self._device}, embedding_dim="
            f"{self._embedding_dim}, image_size={size}"
        )

    def _to_model_dtype(self, tensor: torch.Tensor) -> torch.Tensor:
        return tensor.half() if self._fp16 else tensor

    def encode_images(self, images: Sequence[Any]) -> np.ndarray:
        self._load()
        batch = torch.stack(
            [self._transform(image.convert("RGB")) for image in images]
        )
        batch = self._to_model_dtype(batch).to(self._device)
        with torch.no_grad():
            vision_cls, _ = self._model(image=batch, only_infer=True)
        feats = vision_cls.float().cpu().numpy().astype(np.float32)
        self._assert_normalized(feats)
        return feats

    def encode_texts(self, texts: Sequence[str]) -> np.ndarray:
        self._load()
        encoded = self._tokenizer(
            list(texts),
            padding=True,
            truncation=True,
            max_length=self._max_text_len,
            return_tensors="pt",
        )
        input_ids = encoded["input_ids"].to(self._device)
        # BEiT3 expects padding_mask with 1 at PAD positions (inverse of
        # the Hugging Face attention_mask convention).
        padding_mask = (1 - encoded["attention_mask"]).to(self._device)
        with torch.no_grad():
            _, language_cls = self._model(
                text_description=input_ids,
                padding_mask=padding_mask,
                only_infer=True,
            )
        feats = language_cls.float().cpu().numpy().astype(np.float32)
        self._assert_normalized(feats)
        return feats

    @staticmethod
    def _assert_normalized(feats: np.ndarray) -> None:
        norms = np.linalg.norm(feats, axis=1)
        if not np.allclose(norms, 1.0, atol=1e-2):
            raise RuntimeError(
                f"BEiT-3 embeddings are not L2-normalized (norms={norms[:3]}); "
                "the checkpoint may not be a retrieval head"
            )
