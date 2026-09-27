# BEiT-3 vendor copy

`modeling_finetune.py` and `modeling_utils.py` are copied unmodified from
[microsoft/unilm — beit3](https://github.com/microsoft/unilm/tree/master/beit3)
(retrieved 2026-07-18, master branch), licensed under **The MIT License**
(c) 2023 Microsoft.

`utils.py` in this directory is a project-written inference-only stub that
replaces the upstream training utilities (`ClipLoss`, distributed rank
helpers). It is not part of the upstream distribution.

These modules use flat absolute imports (`import utils`,
`from modeling_utils import ...`), so `src/encoders/beit3_encoder.py` adds
this directory to `sys.path` before importing them. Do not convert them to
package-relative imports — keeping the files byte-identical to upstream
makes future updates diffable.

Runtime dependencies (NOT in the main requirements.txt — install only when
running BEiT-3): see `requirements-beit3.txt` at the repository root.
