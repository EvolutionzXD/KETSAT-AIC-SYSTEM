# Final_AIC backend

This directory is the independent final runtime.  It was derived from the
stable `/home/bachdx/aic_backend_RRF` runtime, then adapted here only:

- visual retrieval uses the read-only Qdrant adapter;
- OCR, ASR and caption retrieval use read-only Typesense collections;
- the existing RRF/KCP/search API remains the application core;
- Batch1 sidecars are referenced by absolute paths so they are not copied
  across NFS unnecessarily.

`/home/bachdx/aic_backend_RRF` is not modified by this runtime.  The default
collection names point at the existing Batch1 collections, so this is safe to
bring up before a new final dataset is indexed.  When a new dataset is ready,
change only the collection and sidecar paths in the private environment file;
build a versioned collection, audit it, then move the Typesense alias before
switching production traffic.

## Read-only preflight

From the server:

```bash
cd /home/bachdx/Final_AIC/backend
python3 validate_runtime.py \
  --env-file /home/bachdx/Final_AIC/database/typesense/typesense.env
```

The check validates settings, the two metadata sidecars, Qdrant collection
dimensions/counts, Typesense health/schemas, and the KCP sidecar.  It does not
load an encoder, write an index, or run a full query.

At the moment the server has the four Batch1 visual collections ready, while
Typesense still exposes only smoke collections.  Therefore the default check
is expected to report missing `ocr_frames_current`, `asr_segments_current`
and `caption_windows_current` until the final versioned collections are built
and their aliases are published.  The smoke collections are useful for adapter
tests only and are not wired into the production defaults.

## Start the API

```bash
cd /home/bachdx/Final_AIC/backend
FINAL_AIC_ENV_FILE=/home/bachdx/Final_AIC/backend/.env \
  ./run_final_api.sh
```

The runner also uses `database/typesense/typesense.env` for the Typesense key when
the private environment file does not define one.  Startup warmup is disabled
by default; set `STARTUP_WARMUP_ENABLED=true` after the model cache and final
sidecars are staged.
