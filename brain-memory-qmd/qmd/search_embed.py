"""Embedding-based semantic search over indexed chunks."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer
    from qmd.ingest import Chunk

DEFAULT_MODEL_NAME = "BAAI/bge-small-zh-v1.5"  # v1.1.9: 中文优化模型
EMBEDDINGS_FILE = "embeddings.npy"


def _load_model(model_name: str = DEFAULT_MODEL_NAME) -> SentenceTransformer:
    """Lazy-load the sentence-transformers model."""
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_name)


def embed_texts(
    texts: list[str],
    model_name: str = DEFAULT_MODEL_NAME,
    batch_size: int = 64,
    show_progress: bool = True,
) -> np.ndarray:
    """Embed a list of texts, returning a (N, dim) float32 numpy array.

    Uses normalize_embeddings=True so cosine similarity = dot product.
    """
    model = _load_model(model_name)
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        show_progress_bar=show_progress,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    return embeddings.astype(np.float32)


def save_embeddings(index_dir: Path, embeddings: np.ndarray) -> Path:
    """Save embeddings array to index directory. Returns path written."""
    index_dir.mkdir(parents=True, exist_ok=True)
    path = index_dir / EMBEDDINGS_FILE
    np.save(path, embeddings)
    return path


def load_embeddings(index_dir: Path) -> np.ndarray | None:
    """Load embeddings from index directory. Returns None if not found."""
    path = index_dir / EMBEDDINGS_FILE
    if not path.exists():
        return None
    return np.load(path)


def embedding_search(
    chunks: list[Chunk],
    query: str,
    embeddings: np.ndarray,
    top_k: int = 5,
    model_name: str = DEFAULT_MODEL_NAME,
) -> list[tuple[int, float]]:
    """Return top-k (chunk_index, score) pairs by cosine similarity.

    Since embeddings are L2-normalized, cosine similarity = dot product.
    """
    model = _load_model(model_name)
    query_vec = model.encode(
        [query],
        normalize_embeddings=True,
        convert_to_numpy=True,
    ).astype(np.float32)

    scores = (embeddings @ query_vec.T).flatten()

    top_indices = scores.argsort()[::-1][:top_k]
    return [(int(idx), float(scores[idx])) for idx in top_indices if scores[idx] > 0]
