"""OCR ranking v2: IDF weighting + fuzzy token match + confidence.

Fixes three systematic failures of plain keyword counting on TV frames:

1. Persistent overlay text (channel logo, "60 giây", clock) appears on
   nearly every frame of a channel, so any query containing such a token
   matched everything. IDF computed over the OCR corpus itself drives the
   weight of a token that appears everywhere toward zero — no manual
   blocklist required.
2. OCR character errors ("6O" for "60", "gìay" for "giay") break exact
   matching. A character-bigram Dice similarity provides a fuzzy fallback
   for tokens that do not match exactly.
3. Detection confidence was stored but unused. Each token now carries the
   maximum confidence among the detections it came from, scaling its
   contribution.

Scores are normalized to [0, 1] per query (fraction of achievable IDF mass
matched), which keeps them comparable across queries for diagnostics. RRF
still only consumes ranks.
"""
import math
from dataclasses import dataclass, field
from typing import Dict, List, Sequence, Set, Tuple

from src.search.query_utils import normalize_for_search

#: Tokens present in more than this fraction of frames are overlay noise;
#: IDF already down-weights them smoothly, this cap just documents intent.
DEFAULT_FUZZY_THRESHOLD = 0.62
_MIN_FUZZY_TOKEN_LEN = 3
_MIN_PHRASE_TOKENS = 2
_MAX_PHRASE_TOKENS = 6


@dataclass
class OCRDocEntry:
    video_id: str
    frame_id: int
    text: str
    # normalized token -> max detection confidence that produced it
    token_confidence: Dict[str, float] = field(default_factory=dict)
    # Space-padded normalize_for_search(text), precomputed once at index
    # build time so phrase-adjacency checks at query time are a plain
    # substring test, not per-query normalization of the whole corpus.
    normalized_text: str = ""


@dataclass
class OCRSearchIndex:
    docs: Dict[str, OCRDocEntry]
    idf: Dict[str, float]
    token_to_docs: Dict[str, Set[str]]
    num_docs: int
    # Character-bigram postings narrow fuzzy matching to vocabulary tokens
    # sharing at least one n-gram with the query token.
    char_bigram_to_tokens: Dict[str, Set[str]] = field(default_factory=dict)
    # Exact normalized phrases (2..N tokens) preserve multi-syllable OCR
    # evidence without scanning every document at query time.
    phrase_to_docs: Dict[str, Set[str]] = field(default_factory=dict)
    phrase_idf: Dict[str, float] = field(default_factory=dict)


def _is_searchable(detection: Dict) -> bool:
    """Honour the per-detection quality gate written by extract_ocr.py.

    Schema 4 keeps every raw detection but marks the ones that failed the
    detector/recognizer confidence gates — station watermarks, texture
    noise, isolated short tokens — as ``searchable: False``. Older records
    have no such key and are indexed as before.
    """
    return bool(detection.get("searchable", True))


def _tokenize_with_confidence(record: Dict) -> Dict[str, float]:
    """Extract normalized tokens with the best confidence backing each."""
    token_confidence: Dict[str, float] = {}
    detections = record.get("detections") or []
    if detections:
        for detection in detections:
            if not _is_searchable(detection):
                continue
            confidence = float(detection.get("confidence", 1.0))
            for token in normalize_for_search(detection.get("text", "")).split():
                if len(token) < 2:
                    continue
                token_confidence[token] = max(
                    token_confidence.get(token, 0.0), confidence
                )
    else:
        # Legacy records without per-detection data: neutral confidence.
        for token in normalize_for_search(record.get("text", "")).split():
            if len(token) < 2:
                continue
            token_confidence[token] = 1.0
    return token_confidence


def _phrase_tokens(record: Dict) -> List[str]:
    """Return ordered normalized tokens used by the exact phrase index.

    Detection rows are kept in OCR reading order. Unsearchable detections
    are excluded so a watermark cannot re-enter through phrase matching.
    Legacy records without detections use their stored text as-is.
    """
    detections = record.get("detections") or []
    if detections:
        tokens: List[str] = []
        for detection in detections:
            if not _is_searchable(detection):
                continue
            tokens.extend(
                normalize_for_search(detection.get("text", "")).split()
            )
        return tokens
    return normalize_for_search(record.get("text", "")).split()


def _phrase_ngrams(tokens: Sequence[str]) -> List[str]:
    """Build ordered exact phrase keys from two to six normalized tokens."""
    phrases: List[str] = []
    for size in range(
        _MIN_PHRASE_TOKENS,
        min(len(tokens), _MAX_PHRASE_TOKENS) + 1,
    ):
        for start in range(0, len(tokens) - size + 1):
            phrase = " ".join(tokens[start : start + size])
            if phrase:
                phrases.append(phrase)
    return phrases


def _char_bigrams(token: str) -> Set[str]:
    padded = f"#{token}#"
    return {padded[i : i + 2] for i in range(len(padded) - 1)}


def char_bigram_similarity(a: str, b: str) -> float:
    """Dice coefficient over padded character bigrams, in [0, 1]."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    bigrams_a = _char_bigrams(a)
    bigrams_b = _char_bigrams(b)
    return 2 * len(bigrams_a & bigrams_b) / (len(bigrams_a) + len(bigrams_b))


def build_ocr_index(ocr_results: Dict[str, Dict]) -> OCRSearchIndex:
    """Build the searchable index once per loaded OCR corpus."""
    docs: Dict[str, OCRDocEntry] = {}
    token_to_docs: Dict[str, Set[str]] = {}
    char_bigram_to_tokens: Dict[str, Set[str]] = {}
    phrase_to_docs: Dict[str, Set[str]] = {}
    for doc_id, record in ocr_results.items():
        token_confidence = _tokenize_with_confidence(record)
        phrase_tokens = _phrase_tokens(record)
        raw_text = record.get("text", "")
        entry = OCRDocEntry(
            video_id=record.get(
                "video_id",
                doc_id.rsplit("_", 1)[0] if "_" in doc_id else doc_id,
            ),
            frame_id=int(record.get("frame_id", 0)),
            text=raw_text,
            token_confidence=token_confidence,
            normalized_text=" " + " ".join(phrase_tokens) + " ",
        )
        docs[doc_id] = entry
        for token in token_confidence:
            token_to_docs.setdefault(token, set()).add(doc_id)
            for bigram in _char_bigrams(token):
                char_bigram_to_tokens.setdefault(bigram, set()).add(token)
        for phrase in _phrase_ngrams(phrase_tokens):
            phrase_to_docs.setdefault(phrase, set()).add(doc_id)

    num_docs = max(len(docs), 1)
    idf = {
        token: math.log((num_docs + 1) / (len(doc_ids) + 1))
        for token, doc_ids in token_to_docs.items()
    }
    phrase_idf = {
        phrase: math.log((num_docs + 1) / (len(doc_ids) + 1))
        for phrase, doc_ids in phrase_to_docs.items()
    }
    return OCRSearchIndex(
        docs=docs,
        idf=idf,
        token_to_docs=token_to_docs,
        num_docs=num_docs,
        char_bigram_to_tokens=char_bigram_to_tokens,
        phrase_to_docs=phrase_to_docs,
        phrase_idf=phrase_idf,
    )


def _unseen_idf(index: OCRSearchIndex) -> float:
    return math.log(index.num_docs + 1)


def score_ocr_query(
    index: OCRSearchIndex,
    query_tokens: Sequence[str],
    *,
    query_text: str = "",
    fuzzy_threshold: float = DEFAULT_FUZZY_THRESHOLD,
) -> List[Tuple[str, float]]:
    """Score documents with IDF, bounded fuzzy matching and exact phrases.

    query_text is optional for callers that already have normalized tokens.
    The production OCR path passes the original query so phrase matching can
    retain stopword/syllable order instead of treating a multi-syllable phrase
    as unrelated bag-of-words tokens.
    """
    normalized_query_tokens: List[str] = []
    for value in query_tokens:
        normalized_query_tokens.extend(
            normalize_for_search(str(value)).split()
        )
    query_tokens = normalized_query_tokens
    if not query_tokens:
        return []
    if not 0.0 < fuzzy_threshold <= 1.0:
        raise ValueError("fuzzy_threshold must be in (0, 1]")

    unseen = _unseen_idf(index)
    achievable = sum(index.idf.get(token, unseen) for token in query_tokens)

    # Use the full query for phrase evidence when available. The lexical
    # token lane still uses filtered query_tokens, so generic words do not
    # dominate ordinary bag-of-words matching.
    phrase_tokens = (
        normalize_for_search(query_text).split()
        if query_text else list(query_tokens)
    )
    phrase_evidence = []
    phrase_postings = getattr(index, "phrase_to_docs", {})
    phrase_idf = getattr(index, "phrase_idf", {})
    if phrase_postings:
        seen_phrases = set()
        for phrase in _phrase_ngrams(phrase_tokens):
            if phrase in seen_phrases:
                continue
            seen_phrases.add(phrase)
            candidates = phrase_postings.get(phrase)
            if not candidates:
                continue
            mass = float(
                phrase_idf.get(
                    phrase,
                    math.log((index.num_docs + 1) / (len(candidates) + 1)),
                )
            )
            if mass <= 0.0:
                continue
            phrase_evidence.append((phrase, candidates, mass))
            achievable += mass
    else:
        # Backward-compatible fallback for an index object created before
        # phrase postings existed.
        for token_a, token_b in zip(query_tokens, query_tokens[1:]):
            candidates = index.token_to_docs.get(token_a, set()) & index.token_to_docs.get(
                token_b, set()
            )
            if not candidates:
                continue
            phrase = f" {token_a} {token_b} "
            mass = index.idf.get(token_a, unseen) + index.idf.get(token_b, unseen)
            phrase_evidence.append((phrase.strip(), candidates, mass))
            achievable += mass

    if achievable <= 0:
        return []

    doc_scores: Dict[str, float] = {}
    vocabulary = list(index.token_to_docs.keys())
    char_postings = getattr(index, "char_bigram_to_tokens", {})
    for query_token in query_tokens:
        contributions: Dict[str, float] = {}

        exact_idf = index.idf.get(query_token)
        if exact_idf is not None:
            for doc_id in index.token_to_docs[query_token]:
                confidence = index.docs[doc_id].token_confidence[query_token]
                contributions[doc_id] = exact_idf * confidence

        if len(query_token) >= _MIN_FUZZY_TOKEN_LEN:
            if char_postings:
                fuzzy_vocabulary = set()
                for bigram in _char_bigrams(query_token):
                    fuzzy_vocabulary.update(
                        char_postings.get(bigram, ())
                    )
            else:
                # Preserve compatibility for callers holding an old
                # OCRSearchIndex that has no fuzzy postings.
                fuzzy_vocabulary = set(vocabulary)
            for vocab_token in fuzzy_vocabulary:
                if vocab_token == query_token:
                    continue
                similarity = char_bigram_similarity(query_token, vocab_token)
                if similarity < fuzzy_threshold:
                    continue
                token_idf = index.idf[vocab_token]
                for doc_id in index.token_to_docs[vocab_token]:
                    confidence = index.docs[doc_id].token_confidence[vocab_token]
                    value = token_idf * similarity * confidence
                    if value > contributions.get(doc_id, 0.0):
                        contributions[doc_id] = value

        for doc_id, value in contributions.items():
            doc_scores[doc_id] = doc_scores.get(doc_id, 0.0) + value

    for phrase, candidates, mass in phrase_evidence:
        phrase_tokens_for_confidence = phrase.split()
        for doc_id in candidates:
            entry = index.docs.get(doc_id)
            if entry is None:
                continue
            confidence = min(
                entry.token_confidence.get(token, 1.0)
                for token in phrase_tokens_for_confidence
            )
            doc_scores[doc_id] = doc_scores.get(doc_id, 0.0) + mass * confidence

    scored = [
        (doc_id, total / achievable)
        for doc_id, total in doc_scores.items()
        if total > 0
    ]
    scored.sort(key=lambda item: (-item[1], item[0]))
    return scored
