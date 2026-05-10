#!/usr/bin/env python3
"""
brain-memory-qmd: 语义记忆搜索工具
基于 QMD（BM25 + 语义嵌入混合搜索）
针对中文记忆文件优化：使用纯嵌入搜索（BM25对中文无效）
"""

import sys
import json
import argparse
from pathlib import Path

# QMD 源码路径
QMD_PATH = Path(__file__).parent / "qmd_src"
sys.path.insert(0, str(QMD_PATH))

from qmd.ingest import ingest_folder, discover_files, chunk_text, Chunk
from qmd.search_embed import embed_texts, save_embeddings, load_embeddings, embedding_search
from qmd.search_bm25 import bm25_search

# 默认配置
INDEX_DIR = Path.home() / ".openclaw/memory-index/qmd"
DEFAULT_MEMORY_DIR = Path.home() / ".openclaw/workspace/memory"
EMBEDDING_MODEL = "BAAI/bge-small-zh-v1.5"  # v1.1.9: 替换英语小模型为中文优化模型


def ensure_index(memory_dir: Path = None) -> tuple[list[Chunk], dict]:
    """确保索引存在，不存在则自动创建；模型变更时自动重建"""
    memory_dir = memory_dir or DEFAULT_MEMORY_DIR
    chunks_path = INDEX_DIR / "chunks.jsonl"
    emb_path = INDEX_DIR / "embeddings.npy"
    model_meta_path = INDEX_DIR / "model_meta.json"

    # v1.1.9: 检测模型变更，自动重建索引
    needs_rebuild = False
    if model_meta_path.exists():
        try:
            meta = json.loads(model_meta_path.read_text())
            if meta.get("model") != EMBEDDING_MODEL:
                print(f"模型已从 {meta.get('model')} 变更为 {EMBEDDING_MODEL}，重建索引...", file=sys.stderr)
                needs_rebuild = True
        except Exception:
            needs_rebuild = True

    if not chunks_path.exists() or not emb_path.exists() or needs_rebuild:
        print("索引不存在或需要重建，正在创建...", file=sys.stderr)
        index_memory(memory_dir, force=needs_rebuild)
        # 保存模型标识
        model_meta_path.write_text(json.dumps({"model": EMBEDDING_MODEL, "updated": __import__("datetime").datetime.now().isoformat()}))

    chunks = load_chunks()
    return chunks, {}


def load_chunks() -> list[Chunk]:
    """从 chunks.jsonl 加载所有 chunk"""
    chunks_path = INDEX_DIR / "chunks.jsonl"
    if not chunks_path.exists():
        return []

    chunks = []
    with open(chunks_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            chunks.append(Chunk(**d))
    return chunks


def index_memory(memory_dir: Path = None, force: bool = False) -> dict:
    """建立或更新记忆索引"""
    memory_dir = memory_dir or DEFAULT_MEMORY_DIR
    INDEX_DIR.mkdir(parents=True, exist_ok=True)

    chunks, stats = ingest_folder(
        input_dir=memory_dir,
        index_dir=INDEX_DIR,
        force=force
    )

    if chunks:
        embeddings = embed_texts([c.text for c in chunks])
        save_embeddings(INDEX_DIR, embeddings)

    return {
        "chunks_count": len(chunks),
        "stats": stats,
        "index_dir": str(INDEX_DIR)
    }


def search_memory(query: str, top_k: int = 5) -> list[dict]:
    """语义搜索记忆"""
    chunks = load_chunks()
    embeddings = load_embeddings(INDEX_DIR)

    if not chunks or embeddings is None:
        return []

    results = embedding_search(chunks, query, embeddings, top_k=top_k)

    return [
        {
            "text": chunks[idx].text,
            "file": chunks[idx].file_name,
            "file_path": chunks[idx].file_path,
            "score": float(score)
        }
        for idx, score in results
    ]


def cmd_index(args):
    """CLI: 建立索引"""
    result = index_memory(Path(args.dir) if args.dir else None, force=args.force)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_search(args):
    """CLI: 搜索记忆"""
    results = search_memory(args.query, top_k=args.top_k)
    print(json.dumps(results, ensure_ascii=False, indent=2))


def cmd_status(args):
    """CLI: 查看索引状态"""
    chunks = load_chunks()
    embeddings = load_embeddings(INDEX_DIR)

    print(json.dumps({
        "chunks_count": len(chunks),
        "embeddings_shape": embeddings.shape if embeddings is not None else None,
        "index_dir": str(INDEX_DIR),
        "exists": (INDEX_DIR / "chunks.jsonl").exists()
    }, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="brain-memory-qmd: 语义记忆搜索")
    subparsers = parser.add_subparsers(dest="cmd")

    # index 命令
    p_index = subparsers.add_parser("index", help="建立记忆索引")
    p_index.add_argument("--dir", help="记忆目录路径")
    p_index.add_argument("--force", action="store_true", help="强制全量重建")

    # search 命令
    p_search = subparsers.add_parser("search", help="搜索记忆")
    p_search.add_argument("query", help="搜索query")
    p_search.add_argument("--top-k", type=int, default=5, help="返回结果数")

    # status 命令
    p_status = subparsers.add_parser("status", help="查看索引状态")

    args = parser.parse_args()

    if args.cmd == "index":
        cmd_index(args)
    elif args.cmd == "search":
        cmd_search(args)
    elif args.cmd == "status":
        cmd_status(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
