"""BM25 lexical search over indexed chunks."""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import get_close_matches

from rank_bm25 import BM25Okapi

from qmd.ingest import Chunk


@dataclass
class SearchResult:
    """A single search result with its score and rank."""

    chunk: Chunk
    score: float
    rank: int


def tokenize(text: str) -> list[str]:
    """Tokenize text for BM25: lowercase, split on non-alphanumeric, drop single chars."""
    tokens = re.split(r"[^a-z0-9]+", text.lower())
    return [t for t in tokens if len(t) > 1]


def expand_query_fuzzy(
    query_tokens: list[str],
    vocabulary: set[str],
    cutoff: float = 0.75,
) -> list[str]:
    """Expand query tokens with fuzzy matches from the corpus vocabulary.

    For each query token not found in the vocabulary, find close matches
    and add them to the query. This handles typos like
    "migratoin" matching "migration".
    """
    expanded = list(query_tokens)
    for token in query_tokens:
        if token not in vocabulary:
            matches = get_close_matches(token, vocabulary, n=3, cutoff=cutoff)
            for m in matches:
                if m not in expanded:
                    expanded.append(m)
    return expanded


def bm25_search(
    chunks: list[Chunk], query: str, top_k: int = 5
) -> list[SearchResult]:
    """Run BM25 search over chunks and return top-k ranked results."""
    if not chunks:
        return []

    tokenized_query = tokenize(query)
    if not tokenized_query:
        return []

    tokenized_corpus = [tokenize(c.text) for c in chunks]

    vocabulary = {token for doc in tokenized_corpus for token in doc}
    tokenized_query = expand_query_fuzzy(tokenized_query, vocabulary)

    bm25 = BM25Okapi(tokenized_corpus)
    scores = bm25.get_scores(tokenized_query)

    sorted_indices = scores.argsort()[::-1][:top_k]

    results = []
    for rank, idx in enumerate(sorted_indices, start=1):
        if scores[idx] > 0:
            results.append(
                SearchResult(
                    chunk=chunks[idx],
                    score=float(scores[idx]),
                    rank=rank,
                )
            )
    return results
