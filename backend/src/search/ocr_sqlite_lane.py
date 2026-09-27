"""Read-only frame-level OCR retrieval for the DeepSeek Video-Lock path."""
from __future__ import annotations

import sqlite3
from pathlib import Path


def _fts_query(tokens):
    unique = list(dict.fromkeys(token for token in tokens if len(token) >= 2))
    return " OR ".join('"%s"' % token.replace('"', "") for token in unique)


def search_ocr_sqlite_hits(path, query_text: str, top_k=100, candidate_limit=4000):
    from src.search.query_utils import normalize_for_search

    tokens = normalize_for_search(query_text or "").split()
    match_query = _fts_query(tokens)
    if not match_query or not Path(path).is_file():
        return []
    uri = "file:%s?mode=ro&immutable=1" % Path(path).as_posix()
    with sqlite3.connect(uri, uri=True, timeout=5.0) as connection:
        rows = connection.execute(
            """
            SELECT doc_id, video_id, frame_id, raw_text, bm25(ocr_fts)
            FROM ocr_fts
            WHERE normalized MATCH ?
            ORDER BY bm25(ocr_fts)
            LIMIT ?
            """,
            (match_query, max(int(top_k), int(candidate_limit))),
        ).fetchall()

    query_tokens = set(tokens)
    phrase = " ".join(tokens)
    rescored = []
    for doc_id, video_id, frame_id, raw_text, bm25_value in rows:
        normalized = normalize_for_search(raw_text or "")
        coverage = len(query_tokens & set(normalized.split())) / max(1, len(query_tokens))
        phrase_match = float(len(tokens) > 1 and phrase in normalized)
        rescored.append(
            (phrase_match, coverage, -float(bm25_value), doc_id,
             video_id, frame_id, raw_text)
        )
    rescored.sort(key=lambda row: (-row[0], -row[1], -row[2], row[3]))
    return [
        {
            "video_id": str(video_id),
            "frame_id": int(frame_id),
            "text": str(raw_text or ""),
            "score": float(min(1.0, 0.75 * coverage + 0.25 * phrase_match)),
            "rank": rank,
        }
        for rank, (phrase_match, coverage, _bm25, _doc_id, video_id,
                   frame_id, raw_text) in enumerate(rescored[:top_k], start=1)
    ]
