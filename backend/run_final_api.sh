#!/usr/bin/env bash
set -euo pipefail

FINAL_AIC_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$FINAL_AIC_ROOT"

FINAL_AIC_ENV_FILE="${FINAL_AIC_ENV_FILE:-$FINAL_AIC_ROOT/.env}"
if [ -f "$FINAL_AIC_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$FINAL_AIC_ENV_FILE"
  set +a
fi

TYPESENSE_ENV_FILE="${TYPESENSE_ENV_FILE:-$FINAL_AIC_ROOT/../database/typesense/typesense.env}"
if [ -z "${TYPESENSE_API_KEY:-}" ] && [ -f "$TYPESENSE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$TYPESENSE_ENV_FILE"
  set +a
fi

export PYTHONPATH="$FINAL_AIC_ROOT${PYTHONPATH:+:$PYTHONPATH}"
FINAL_AIC_PYTHON="/home/bachdx/venvs/aic_search_api/bin/python"
FINAL_AIC_LOG_LEVEL="${LOG_LEVEL:-info}"
FINAL_AIC_LOG_LEVEL="$(printf '%s' "$FINAL_AIC_LOG_LEVEL" | tr '[:upper:]' '[:lower:]')"
exec "$FINAL_AIC_PYTHON" -m uvicorn backend.app:app \
  --host "${FINAL_AIC_HOST:-${HOST:-0.0.0.0}}" \
  --port "${FINAL_AIC_PORT:-${PORT:-8602}}" \
  --workers "${API_WORKERS:-1}" \
  --log-level "$FINAL_AIC_LOG_LEVEL"
