"""
Query Cache — LRU cache cho query embeddings và results.

Fixes bottleneck:
- B6: Model inference lặp lại cho cùng query → cache embeddings

Usage:
    from src.pipeline.query_cache import QueryCache, get_query_cache

    cache = get_query_cache()

    # Cache PE-Core embedding
    embedding = cache.get_pe_core_embedding("diễn giả mặc áo đỏ")

    # Cache full search results
    results = cache.get_results("diễn giả", top_k=10)
"""

import hashlib
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from dataclasses import dataclass
from collections import OrderedDict
from loguru import logger

import numpy as np


@dataclass
class CacheStats:
    """Cache statistics."""
    hits: int = 0
    misses: int = 0
    evictions: int = 0

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total > 0 else 0.0


class LRUCache:
    """
    Thread-safe LRU cache với TTL support.
    """

    def __init__(self, max_size: int = 500, ttl_seconds: float = 3600):
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self._cache: OrderedDict = OrderedDict()
        self._timestamps: Dict[str, float] = {}
        self._stats = CacheStats()
        self._lock = __import__('threading').Lock()

    def get(self, key: str) -> Optional[Any]:
        """Get value from cache."""
        with self._lock:
            if key not in self._cache:
                self._stats.misses += 1
                return None

            # Check TTL
            if time.time() - self._timestamps[key] > self.ttl_seconds:
                del self._cache[key]
                del self._timestamps[key]
                self._stats.misses += 1
                return None

            # Move to end (most recently used)
            self._cache.move_to_end(key)
            self._stats.hits += 1
            return self._cache[key]

    def set(self, key: str, value: Any):
        """Set value in cache."""
        with self._lock:
            # Remove if exists
            if key in self._cache:
                del self._cache[key]

            # Evict oldest if at capacity
            while len(self._cache) >= self.max_size:
                oldest_key = next(iter(self._cache))
                del self._cache[oldest_key]
                del self._timestamps[oldest_key]
                self._stats.evictions += 1

            self._cache[key] = value
            self._timestamps[key] = time.time()

    def clear(self):
        """Clear all cache."""
        with self._lock:
            self._cache.clear()
            self._timestamps.clear()

    @property
    def stats(self) -> CacheStats:
        return self._stats

    def __len__(self) -> int:
        return len(self._cache)


class QueryCache:
    """
    Cache cho query embeddings và search results.

    Separate caches cho:
    - PE-Core text embeddings
    - BGE text embeddings
    - Full search results
    """

    def __init__(
        self,
        embedding_cache_size: int = 500,
        results_cache_size: int = 200,
        ttl_seconds: float = 3600
    ):
        self.embedding_cache = LRUCache(max_size=embedding_cache_size, ttl_seconds=ttl_seconds)
        self.results_cache = LRUCache(max_size=results_cache_size, ttl_seconds=ttl_seconds)

    def _hash_query(self, query: str, **kwargs) -> str:
        """Generate cache key from query and params."""
        key_parts = [query]
        for k, v in sorted(kwargs.items()):
            key_parts.append(f"{k}={v}")
        key_str = "|".join(key_parts)
        return hashlib.sha256(key_str.encode()).hexdigest()[:16]

    def get_pe_core_embedding(self, query: str) -> Optional[np.ndarray]:
        """Get a cached PE-Core text embedding."""
        key = self._hash_query(query)
        return self.embedding_cache.get(f"pe_core:{key}")

    def set_pe_core_embedding(self, query: str, embedding: np.ndarray):
        """Cache a PE-Core text embedding."""
        key = self._hash_query(query)
        self.embedding_cache.set(f"pe_core:{key}", embedding)

    def get_bge_embedding(self, query: str) -> Optional[np.ndarray]:
        """Get cached BGE embedding."""
        key = self._hash_query(query)
        return self.embedding_cache.get(f"bge:{key}")

    def set_bge_embedding(self, query: str, embedding: np.ndarray):
        """Cache BGE embedding."""
        key = self._hash_query(query)
        self.embedding_cache.set(f"bge:{key}", embedding)

    def get_bge_m3_embedding(self, query: str) -> Optional[np.ndarray]:
        """Get a cached BGE-M3 text embedding (search_audio's ASR encoder).

        Deliberately separate from get_bge_embedding's "bge:" prefix — that
        one caches whatever encode_text_dense's configurable
        text_embed_model_name currently is (phobert-large by default), a
        different embedding space that would silently corrupt lookups if
        both shared a key namespace.
        """
        key = self._hash_query(query)
        return self.embedding_cache.get(f"bge_m3:{key}")

    def set_bge_m3_embedding(self, query: str, embedding: np.ndarray):
        """Cache a BGE-M3 text embedding."""
        key = self._hash_query(query)
        self.embedding_cache.set(f"bge_m3:{key}", embedding)

    def get_jina_v5_embedding(self, query: str) -> Optional[np.ndarray]:
        """Get a cached Jina v5 text-query embedding.

        Jina has its own namespace because its 768-dim retrieval space is
        unrelated to BGE/PE-Core/SigLIP2 even when the query string is the
        same.
        """
        key = self._hash_query(query)
        return self.embedding_cache.get(f"jina_v5:{key}")

    def set_jina_v5_embedding(self, query: str, embedding: np.ndarray):
        """Cache a Jina v5 text-query embedding."""
        key = self._hash_query(query)
        self.embedding_cache.set(f"jina_v5:{key}", embedding)

    def get_results(self, query: str, top_k: int = 10, **kwargs) -> Optional[List[Dict]]:
        """Get cached search results."""
        key = self._hash_query(query, top_k=top_k, **kwargs)
        return self.results_cache.get(f"results:{key}")

    def set_results(self, query: str, results: List[Dict], top_k: int = 10, **kwargs):
        """Cache search results."""
        key = self._hash_query(query, top_k=top_k, **kwargs)
        self.results_cache.set(f"results:{key}", results)

    def clear(self):
        """Clear all caches."""
        self.embedding_cache.clear()
        self.results_cache.clear()
        logger.info("Query cache cleared")

    def get_stats(self) -> Dict:
        """Get cache statistics."""
        return {
            "embedding_cache": {
                "size": len(self.embedding_cache),
                "hits": self.embedding_cache.stats.hits,
                "misses": self.embedding_cache.stats.misses,
                "hit_rate": f"{self.embedding_cache.stats.hit_rate:.1%}",
                "evictions": self.embedding_cache.stats.evictions,
            },
            "results_cache": {
                "size": len(self.results_cache),
                "hits": self.results_cache.stats.hits,
                "misses": self.results_cache.stats.misses,
                "hit_rate": f"{self.results_cache.stats.hit_rate:.1%}",
                "evictions": self.results_cache.stats.evictions,
            },
        }


# === Global Instance ===

_global_cache: Optional[QueryCache] = None


def get_query_cache() -> QueryCache:
    """Get global query cache instance."""
    global _global_cache
    if _global_cache is None:
        _global_cache = QueryCache()
    return _global_cache


def reset_cache():
    """Reset global cache."""
    global _global_cache
    if _global_cache is not None:
        _global_cache.clear()
    _global_cache = None
