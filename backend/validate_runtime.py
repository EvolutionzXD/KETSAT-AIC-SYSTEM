#!/usr/bin/env python3
"""Model-free, read-only preflight for the Final_AIC runtime."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request


def load_env_file(path: Optional[Path]) -> None:
    if path is None:
        return
    if not path.is_file():
        raise RuntimeError("env file does not exist: %s" % path)
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key:
            os.environ[key] = value


def get_json(url: str, headers: Optional[Mapping[str, str]] = None) -> Any:
    request = urllib.request.Request(url, headers=dict(headers or {}), method="GET")
    try:
        with urllib.request.urlopen(request, timeout=15.0) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("HTTP %d from %s" % (error.code, url)) from error
    except (urllib.error.URLError, ValueError) as error:
        raise RuntimeError("request failed for %s: %s" % (url, error)) from error


def check_file(settings: Any, attr: str, errors: List[str], required: bool = True) -> None:
    value = getattr(settings, attr, None)
    if value is None:
        if required:
            errors.append("setting %s is empty" % attr)
        return
    path = settings.resolve_path(value)
    if not path.is_file() and required:
        errors.append("missing %s: %s" % (attr, path))


def qdrant_collection(
    settings: Any, collection: str, expected_dimension: int
) -> Dict[str, Any]:
    base = str(settings.qdrant_url).rstrip("/")
    encoded = urllib.parse.quote(collection, safe="")
    value = get_json(base + "/collections/" + encoded)
    result = value.get("result", {}) if isinstance(value, dict) else {}
    config = result.get("config", {})
    params = config.get("params", {})
    vectors = params.get("vectors")
    # REST represents an unnamed single vector as {"size": ..., "distance":
    # ...}; named vectors are a mapping whose keys are vector names.
    if isinstance(vectors, dict) and "size" not in vectors:
        configured = vectors.get("embedding")
        vector_mode = "named:embedding"
        if configured is None:
            raise RuntimeError("%s has named vectors but no embedding lane" % collection)
    else:
        configured = vectors
        vector_mode = "unnamed"
    if not isinstance(configured, dict):
        raise RuntimeError("%s has an unreadable vector schema" % collection)
    dimension = int(configured.get("size", 0))
    if dimension != int(expected_dimension):
        raise RuntimeError(
            "%s dimension %d != %d" % (collection, dimension, expected_dimension)
        )
    return {
        "collection": collection,
        "vector_mode": vector_mode,
        "dimension": dimension,
        "points_count": result.get("points_count"),
        "status": result.get("status"),
    }


def typesense_collection(
    settings: Any, collection: str, required_fields: Iterable[str]
) -> Dict[str, Any]:
    base = str(settings.typesense_url).rstrip("/")
    encoded = urllib.parse.quote(collection, safe="")
    headers = {"X-TYPESENSE-API-KEY": str(settings.typesense_api_key or "")}
    value = get_json(base + "/collections/" + encoded, headers=headers)
    fields = {
        field.get("name")
        for field in value.get("fields", [])
        if isinstance(field, dict)
    }
    missing = sorted(set(required_fields) - fields)
    if missing:
        raise RuntimeError("%s missing fields: %s" % (collection, ", ".join(missing)))
    return {
        "collection": collection,
        "documents": value.get("num_documents"),
        "fields_checked": sorted(set(required_fields)),
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--skip-qdrant", action="store_true")
    parser.add_argument("--skip-typesense", action="store_true")
    parser.add_argument("--no-network", action="store_true")
    args = parser.parse_args(argv)

    try:
        load_env_file(args.env_file)
        root = Path(__file__).resolve().parent
        if str(root.parent) not in sys.path:
            sys.path.insert(0, str(root.parent))
        from src.config import get_settings

        settings = get_settings()
    except Exception as error:
        print(json.dumps({"ok": False, "errors": [str(error)]}, ensure_ascii=False))
        return 1

    errors: List[str] = []
    warnings: List[str] = []
    report: Dict[str, Any] = {
        "runtime": "Final_AIC",
        "model_free": True,
        "mutations": False,
        "visual_backend": settings.visual_index_backend,
        "text_backend": settings.text_index_backend,
    }

    check_file(settings, "frame_mapping_path", errors)
    check_file(settings, "video_metadata_path", errors)
    if settings.rrf_kcp_enabled:
        check_file(settings, "rrf_kcp_segments_path", errors)

    if not args.no_network and not args.skip_qdrant:
        visual_report: List[Dict[str, Any]] = []
        visual_specs = (
            (settings.qdrant_pe_core_collection, 1024),
            (settings.qdrant_beit3_collection, 1024),
            (settings.qdrant_siglip2_collection, 1152),
        )
        if settings.jina_v5_enabled:
            visual_specs += ((settings.qdrant_jina_v5_collection, 768),)
        for collection, dimension in visual_specs:
            try:
                visual_report.append(qdrant_collection(settings, collection, dimension))
            except Exception as error:
                errors.append("Qdrant: %s" % error)
        report["qdrant"] = visual_report
    elif args.no_network:
        report["qdrant"] = "skipped (--no-network)"

    if not args.no_network and not args.skip_typesense:
        try:
            health = get_json(str(settings.typesense_url).rstrip("/") + "/health")
            if not isinstance(health, dict) or health.get("ok") is not True:
                raise RuntimeError("Typesense health is not ok")
            if not settings.typesense_api_key:
                raise RuntimeError("TYPESENSE_API_KEY is not set")
            report["typesense_health"] = health
            report["typesense"] = {
                "ocr": typesense_collection(
                    settings,
                    settings.typesense_ocr_collection,
                    ("video_id", "frame_id", "raw_text", "normalized"),
                ),
                "asr": typesense_collection(
                    settings,
                    settings.typesense_asr_collection,
                    (
                        "video_id", "start_seconds", "end_seconds", "text",
                        "normalized", "granularity",
                    ),
                ),
                "caption": typesense_collection(
                    settings,
                    settings.typesense_caption_collection,
                    (
                        "video_id", "start_seconds", "end_seconds", "full_text",
                        "normalized", "visual_description", "actions", "scene",
                        "visible_text", "spoken_summary", "entities",
                    ),
                ),
            }
        except Exception as error:
            errors.append("Typesense: %s" % error)
    elif args.no_network:
        report["typesense"] = "skipped (--no-network)"

    if not settings.jina_v5_enabled:
        warnings.append("JINA_V5_ENABLED is false; the fourth visual lane is disabled")
    if not settings.startup_warmup_enabled:
        warnings.append("startup warmup is disabled; first live query will be cold")

    report["warnings"] = warnings
    report["errors"] = errors
    report["ok"] = not errors
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if report["ok"]:
        print("FINAL_AIC_PREFLIGHT_OK", flush=True)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
