"""
Query normalization utilities.

Handles Vietnamese/English text normalization for better retrieval matching:
- Unicode normalization (NFC/NFD)
- Lowercase
- Accent/diacritic stripping for fallback matching
- Keyword extraction (object, time, location, action)
- Language detection
"""
import re
import unicodedata
from functools import lru_cache
from typing import List, Optional, Tuple

import torch


# Vietnamese vowel map for accent stripping
_VN_MAP = {
    "à": "a", "á": "a", "ả": "a", "ã": "a", "ạ": "a",
    "ă": "a", "ằ": "a", "ắ": "a", "ẳ": "a", "ẵ": "a", "ặ": "a",
    "â": "a", "ầ": "a", "ấ": "a", "ẩ": "a", "ẫ": "a", "ậ": "a",
    "è": "e", "é": "e", "ẻ": "e", "ẽ": "e", "ẹ": "e",
    "ê": "e", "ề": "e", "ế": "e", "ể": "e", "ễ": "e", "ệ": "e",
    "ì": "i", "í": "i", "ỉ": "i", "ĩ": "i", "ị": "i",
    "ò": "o", "ó": "o", "ỏ": "o", "õ": "o", "ọ": "o",
    "ô": "o", "ồ": "o", "ố": "o", "ổ": "o", "ỗ": "o", "ộ": "o",
    "ơ": "o", "ờ": "o", "ớ": "o", "ở": "o", "ỡ": "o", "ợ": "o",
    "ù": "u", "ú": "u", "ủ": "u", "ũ": "u", "ụ": "u",
    "ư": "u", "ừ": "u", "ứ": "u", "ử": "u", "ữ": "u", "ự": "u",
    "ỳ": "y", "ý": "y", "ỷ": "y", "ỹ": "y", "ỵ": "y",
    "đ": "d",
}

_ACCENT_RE = re.compile("|".join(_VN_MAP.keys()))


# Vietnamese common synonyms and expansions
VIETNAMESE_EXPANSIONS: List[Tuple[str, List[str]]] = [
    # Clothing/appearance
    ("áo đỏ", ["áo đỏ", "áo màu đỏ", "diễn giả mặc áo đỏ", "người mặc áo đỏ"]),
    ("áo xanh", ["áo xanh", "áo màu xanh", "người mặc áo xanh"]),
    ("áo trắng", ["áo trắng", "áo màu trắng", "người mặc áo trắng"]),
    ("vest", ["vest", "áo vest", "bộ vest", "suit"]),
    ("áo dài", ["áo dài", "áo truyền thống", "áo nón dìa"]),

    # Actions
    ("chạy", ["chạy", "running", "sprint", "giậm chân"]),
    ("nhảy", ["nhảy", "jump", "leap", "giậm nhảy", "nhảy cao"]),
    ("đi bộ", ["đi bộ", "walking", "walk"]),
    ("ngồi", ["ngồi", "sitting", "sit", "ngồi xuống"]),
    ("đứng", ["đứng", "standing", "stand", "đứng lên"]),

    # People
    ("diễn giả", ["diễn giả", "người nói", "speaker", "người thuyết trình"]),
    ("giám khảo", ["giám khảo", "judge", "ban giám khảo", "jury"]),
    ("mc", ["mc", "host", "người dẫn chương trình", "người dẫn"]),
    ("vận động viên", ["vận động viên", "athlete", "vđv", "vận động viên"]),

    # Objects
    ("micro", ["micro", "microphone", "mic", "vi mô", "microphone cầm tay"]),
    ("bảng", ["bảng", "board", "blackboard", "whiteboard", "bảng trắng", "bảng đen"]),
    ("máy tính", ["máy tính", "computer", "laptop", "pc"]),
    ("điện thoại", ["điện thoại", "phone", "smartphone", "điện thoại di động"]),

    # Scene/context
    ("sân khấu", ["sân khấu", "stage", "đài", "stage area"]),
    ("phòng gym", ["phòng gym", "gym", "phòng tập gym", "fitness center"]),
    ("bãi biển", ["bãi biển", "beach", "cánh đồng", "field"]),
    ("phòng họp", ["phòng họp", "meeting room", "conference room"]),
]


def expand_query(query: str, max_expansions: int = 5) -> List[str]:
    """
    Expand query with synonyms and variants.
    
    Args:
        query: Original query
        max_expansions: Maximum number of expanded variants to return
        
    Returns:
        List of query variants, starting with original
    """
    if not query:
        return [query]

    results = [query]
    normalized = normalize_for_search(query)

    for pattern, variants in VIETNAMESE_EXPANSIONS:
        if pattern in normalized or pattern in query.lower():
            for variant in variants:
                if variant not in results and len(results) < max_expansions + 1:
                    results.append(variant)
            if len(results) >= max_expansions + 1:
                break

    return results[:max_expansions + 1]



def strip_accents(text: str) -> str:
    """Remove Vietnamese diacritics for fuzzy matching."""
    result = _ACCENT_RE.sub(lambda m: _VN_MAP[m.group(0)], text)
    return result


def segment_vietnamese(text: str) -> str:
    """
    Segment Vietnamese words using pyvi (required for PhoBERT).
    Loads pyvi lazily to save startup time.
    """
    if not text:
        return ""
    try:
        from pyvi import ViTokenizer
        return ViTokenizer.tokenize(text)
    except ImportError:
        # Fallback if pyvi is not installed
        return text

def normalize_text(text: str) -> str:
    """
    Normalize text for matching:
    - Strip extra whitespace
    - Lowercase
    - Unicode NFC normalization
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip().lower()


# A quoted span is an explicit user signal that the text should be searched
# against on-screen OCR.  Support straight quotes (the UI's normal form) and
# the two common typographic variants without treating an unmatched quote as
# a routing instruction.
_QUOTED_OCR_RE = re.compile(
    r'"([^"\r\n]+)"|“([^”\r\n]+)”|«([^»\r\n]+)»'
)


def extract_quoted_ocr_query(text: str) -> str:
    """Return the concatenated contents of explicitly quoted OCR spans.

    Multiple quoted spans are kept in input order.  An empty or unmatched
    quote returns an empty string, allowing callers to retain their normal
    whole-query fallback.  Quote characters themselves are never sent to the
    OCR lexical/semantic rankers.
    """
    values = []
    for match in _QUOTED_OCR_RE.finditer(str(text or "")):
        value = next((group for group in match.groups() if group), "")
        value = re.sub(r"\s+", " ", value).strip()
        if value:
            values.append(value)
    return " ".join(values)


def normalize_for_search(text: str) -> str:
    """
    Full normalization pipeline:
    1. Normalize Unicode (NFC)
    2. Lowercase
    3. Strip accents (for fuzzy matching)
    4. Remove punctuation (optional, for text search)
    """
    text = normalize_text(text)
    text = strip_accents(text)
    text = re.sub(r"[^\w\s]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def extract_keywords(text: str) -> List[str]:
    """
    Extract potential search keywords from query.
    Focuses on: objects, colors, actions, people, locations, time references.
    """
    text_lower = normalize_for_search(text)

    # Stopwords, written already accent-stripped (matching text_lower, which
    # went through normalize_for_search -> strip_accents). Writing accented
    # Vietnamese here (e.g. "một") silently never matches anything, since
    # comparison happens on stripped text — found 2026-07-29 via a real
    # UIT-OpenViIC caption-ranker RRF regression (equal-weight RRF dropped
    # R@1 from 56.3% to 40.3%): "một"/"và"/etc. were passing straight through
    # as "keywords" and inflating spurious cross-image matches. Also expanded
    # with generic classifier/descriptor words ("người", "cái", "chiếc",
    # "màu", "bên"...) that are near-universal in image-caption text and
    # therefore useless as discriminating keywords for this domain.
    stopwords = {
        "va", "cua", "la", "co", "duoc", "trong", "voi", "mot", "nhung",
        "theo", "tai", "cho", "ve", "tu", "nay", "khi", "nhu", "dang",
        "nguoi", "cai", "chiec", "mau", "ben", "phia", "tren", "duoi",
        "kia", "day", "do", "cac", "moi", "rat", "cung", "hai", "ba",
        # Generic geographic/administrative filler ("địa phương", "miền
        # Nam", "vừa có thêm khoảng") — near-universal across Vietnamese
        # news captions regardless of topic, so they falsely match unrelated
        # OCR/caption content that happens to mention any locality. Found
        # 2026-08-09 via a real query ("đàn hổ tại một địa phương ở miền
        # Nam...") whose top OCR hit was a demographics slide about
        # "miền núi" / "địa lý dân cư" — ocr_score 0.65 despite zero topical
        # overlap. Same class of bug as the "một"/"và" fix above.
        "dia", "phuong", "mien", "vua", "khoang",
        "the", "a", "an", "is", "are", "was", "were", "in", "on", "at",
        "with", "and", "or", "of", "to", "for", "from", "that", "this",
    }

    words = text_lower.split()
    # len(w) >= 2 (not > 2): many meaningful single-syllable Vietnamese
    # nouns are only 2 characters once accents are stripped ("hổ"->"ho",
    # "gà"->"ga", "bò"->"bo", "cá"->"ca") — a >2 filter silently dropped the
    # single most important word ("hổ"/tiger) from the real query that
    # exposed the geographic-filler bug above, so no OCR/caption ranker
    # ever searched for it at all. The stopword set above already absorbs
    # the 2-char noise this widening lets through ("la", "ba", "do", "ve").
    keywords = [w for w in words if len(w) >= 2 and w not in stopwords]
    return keywords


def parse_time_reference(text: str) -> Tuple[Optional[float], Optional[float]]:
    """
    Parse time references from Vietnamese/English text.

    Returns:
        (start_time, end_time) in seconds, or (None, None) if no time found
    """
    text_lower = text.lower()

    # Vietnamese time patterns
    patterns = [
        # giây/thứ hai/phút
        (r"(\d+)\s*giây", 1.0),
        (r"(\d+)\s*phút", 60.0),
        (r"(\d+)\s*tiếng", 3600.0),
        (r"phút\s*thứ\s*(\d+)", 60.0),
        (r"giây\s*thứ\s*(\d+)", 1.0),
        # English patterns
        (r"(\d+)\s*seconds?", 1.0),
        (r"(\d+)\s*minutes?", 60.0),
        (r"at\s*(\d+)\s*min", 60.0),
        (r"at\s*(\d+)\s*sec", 1.0),
        # generic timestamp
        (r"(\d{1,2}):(\d{2})(?::(\d{2}))?", None),
    ]

    for pattern, multiplier in patterns:
        match = re.search(pattern, text_lower)
        if match:
            if multiplier:
                value = float(match.group(1)) * multiplier
                return (value, value + 10.0)
            else:
                minutes = int(match.group(1))
                seconds = int(match.group(2))
                ms = int(match.group(3)) if match.group(3) else 0
                total = minutes * 60 + seconds + ms / 1000
                return (total, total + 10.0)

    return None, None


def detect_language(text: str) -> str:
    """Simple heuristic language detection."""
    text_lower = text.lower()
    vn_chars = sum(1 for c in text_lower if c in _VN_MAP or ord(c) > 127)
    latin_chars = sum(1 for c in text_lower if c.isalpha() and ord(c) < 128)
    if vn_chars > latin_chars * 0.3:
        return "vi"
    return "en"


@lru_cache(maxsize=1000)
def cached_normalize(text: str) -> str:
    """Cached version of normalize_text for repeated queries."""
    return normalize_text(text)


@lru_cache(maxsize=1000)
def cached_normalize_for_search(text: str) -> str:
    """Cached version of normalize_for_search."""
    return normalize_for_search(text)


def parse_query_to_triplets(query: str) -> List[Tuple[str, str, str]]:
    """
    Parse a query into a list of Subject-Verb-Object triplets using spaCy.
    Loads spaCy lazily to avoid startup delay and handles missing dependencies gracefully.

    Gated to English-detected text only (found 2026-07-29): this uses
    ``en_core_web_sm``, an English-only POS/dependency model — its "VERB"
    detection and nsubj/dobj/pobj dependency labels have no meaning for
    Vietnamese grammar, so feeding it Vietnamese text (the project's primary
    query language) would silently produce garbage or empty triplets rather
    than erroring. Previously masked by spaCy not being installed at all;
    gating on language explicitly means this stays safe even after spaCy is
    installed, until a real Vietnamese-capable parser replaces it (see
    docs/AIC2026_PhoBERT_VnCoreNLP_Addendum.md — VnCoreNLP dependency-role
    heuristic, not yet built).
    """
    if not query:
        return []
    if detect_language(query) != "en":
        return []

    try:
        import spacy
    except ImportError:
        # Fallback if spacy is not installed: just return empty triplets to disable graph search safely
        return []

    # Use a global or function-level cache for the model
    if not hasattr(parse_query_to_triplets, "nlp"):
        try:
            parse_query_to_triplets.nlp = spacy.load("en_core_web_sm")
        except OSError:
            # If model is not downloaded
            return []

    doc = parse_query_to_triplets.nlp(query)
    triplets = []
    
    for token in doc:
        if token.pos_ == "VERB":
            subjects = [w.text.lower() for w in token.lefts if w.dep_ in ("nsubj", "nsubjpass")]
            # "prep" deliberately excluded here (found 2026-07-29 via a real
            # complex-sentence test): a "prep"-labeled child IS the
            # preposition word itself ("on", "into", "with"), not an object
            # entity — including it produced nonsense objects like
            # ('', 'cut', 'on') alongside the correct one. The real object of
            # a prepositional phrase is the "prep" token's OWN child (pobj),
            # which the loop below already extracts correctly.
            objects = [w.text.lower() for w in token.rights if w.dep_ in ("dobj", "pobj", "attr")]

            for child in token.rights:
                if child.dep_ == "prep":
                    objects.extend([w.text.lower() for w in child.rights if w.dep_ in ("pobj", "pcomp")])
            
            subjects = list(set([s for s in subjects if s]))
            objects = list(set([o for o in objects if o]))
            
            if subjects and objects:
                for subj in subjects:
                    for obj in objects:
                        triplets.append((subj, token.lemma_.lower(), obj))
            elif subjects:
                for subj in subjects:
                    triplets.append((subj, token.lemma_.lower(), ""))
            elif objects:
                for obj in objects:
                    triplets.append(("", token.lemma_.lower(), obj))
                    
    return triplets
