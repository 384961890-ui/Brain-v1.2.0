"""Hybrid retrieval: BM25 + embedding search with RRF fusion."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from qmd.ingest import Chunk

from qmd.search_bm25 import SearchResult, bm25_search
from qmd.search_embed import embedding_search, load_embeddings

RRF_K = 60  # Standard RRF constant


def rrf_merge(
    ranked_lists: list[list[tuple[int, float]]],
    top_k: int,
    k: int = RRF_K,
) -> list[tuple[int, float]]:
    """Reciprocal Rank Fusion over multiple ranked lists.

    Each ranked list is [(chunk_index, original_score), ...] ordered by rank.
    Returns [(chunk_index, rrf_score), ...] sorted descending by RRF score.
    """
    scores: dict[int, float] = {}
    for ranked_list in ranked_lists:
        for rank_pos, (chunk_idx, _original_score) in enumerate(ranked_list, start=1):
            scores[chunk_idx] = scores.get(chunk_idx, 0.0) + 1.0 / (k + rank_pos)

    sorted_items = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return sorted_items[:top_k]


def hybrid_search(
    chunks: list[Chunk],
    query: str,
    index_dir: Path,
    top_k: int = 5,
    retrieval_depth: int = 20,
) -> list[SearchResult]:
    """Run hybrid BM25 + embedding search with RRF fusion.

    If embeddings are not available, falls back to BM25-only.
    """
    # Always run BM25
    bm25_results = bm25_search(chunks, query, top_k=retrieval_depth)

    # Try to load embeddings for semantic search
    embeddings = load_embeddings(index_dir)

    if embeddings is None or len(embeddings) != len(chunks):
        # No embeddings or stale — fall back to BM25-only
        return _assign_ranks(bm25_results[:top_k])

    # Run embedding search
    embed_results = embedding_search(
        chunks, query, embeddings, top_k=retrieval_depth
    )

    # Convert BM25 results to (index, score) tuples for RRF
    bm25_tuples = _results_to_tuples(bm25_results, chunks)

    # Fuse with RRF
    fused = rrf_merge([bm25_tuples, embed_results], top_k=top_k)

    # Build SearchResult objects
    results = [
        SearchResult(chunk=chunks[chunk_idx], score=rrf_score, rank=0)
        for chunk_idx, rrf_score in fused
    ]

    return _assign_ranks(results)


def _results_to_tuples(
    results: list[SearchResult], chunks: list[Chunk]
) -> list[tuple[int, float]]:
    """Convert SearchResult list to (chunk_index, score) tuples."""
    chunk_id_to_idx = {c.chunk_id: i for i, c in enumerate(chunks)}
    return [
        (chunk_id_to_idx[r.chunk.chunk_id], r.score)
        for r in results
        if r.chunk.chunk_id in chunk_id_to_idx
    ]


def _assign_ranks(results: list[SearchResult]) -> list[SearchResult]:
    """Assign 1-based rank values to results (already sorted)."""
    for i, r in enumerate(results, start=1):
        r.rank = i
    return results
