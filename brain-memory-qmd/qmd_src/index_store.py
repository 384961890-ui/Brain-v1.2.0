"""Index storage and loading utilities."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from qmd.ingest import Chunk


def load_chunks(index_dir: Path) -> list[Chunk]:
    """Load chunks from chunks.jsonl in the given index directory."""
    chunks_path = index_dir / "chunks.jsonl"
    if not chunks_path.exists():
        raise FileNotFoundError(
            f"No chunks.jsonl found in {index_dir}. Run 'qmd ingest' first."
        )

    chunks: list[Chunk] = []
    with open(chunks_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                chunks.append(Chunk(**d))
            except (json.JSONDecodeError, TypeError) as e:
                raise ValueError(
                    f"Error parsing line {line_num} in {chunks_path}: {e}"
                ) from e
    return chunks


def embeddings_info(index_dir: Path) -> dict[str, int] | None:
    """Return embedding metadata (count, dimensions) or None if not present."""
    path = index_dir / "embeddings.npy"
    if not path.exists():
        return None
    import numpy as np

    emb = np.load(path)
    return {"count": emb.shape[0], "dimensions": emb.shape[1]}


def save_chunks(index_dir: Path, chunks: list[Chunk]) -> Path:
    """Write chunks to chunks.jsonl. Returns the path written."""
    index_dir.mkdir(parents=True, exist_ok=True)
    chunks_path = index_dir / "chunks.jsonl"
    with open(chunks_path, "w", encoding="utf-8") as f:
        for chunk in chunks:
            f.write(json.dumps(asdict(chunk), ensure_ascii=False) + "\n")
    return chunks_path
