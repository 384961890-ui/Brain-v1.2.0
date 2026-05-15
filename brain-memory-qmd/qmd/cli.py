"""CLI entry point for QMD Local Document Search."""

from __future__ import annotations

from pathlib import Path

import click

from qmd import __version__

# Output token cost per 1M tokens by model prefix
_OUTPUT_COST_PER_M = {
    "gpt-4.1-nano": 0.40,
    "gpt-4.1-mini": 1.60,
    "gpt-4.1": 8.00,
    "gpt-4o-mini": 0.60,
    "gpt-4o": 10.00,
    "gpt-5.2": 14.00,
    "claude-haiku": 1.25,
    "claude-sonnet": 15.00,
    "claude-opus": 75.00,
}


def _print_usage(usage: dict) -> None:
    """Print output token count and estimated cost."""
    import os

    model = os.environ.get("OPENAI_MODEL") or os.environ.get("ANTHROPIC_MODEL") or ""
    out_tokens = usage.get("output_tokens", 0)
    # Find matching cost rate
    cost_per_m = None
    for prefix, rate in _OUTPUT_COST_PER_M.items():
        if model.startswith(prefix):
            cost_per_m = rate
            break
    if cost_per_m is not None:
        est_cost = out_tokens * cost_per_m / 1_000_000
        click.echo(f"  Tokens: {out_tokens} output | ~${est_cost:.6f}")
    else:
        click.echo(f"  Tokens: {out_tokens} output")


@click.group()
@click.version_option(version=__version__, prog_name="qmd")
def main() -> None:
    """QMD Local Document Search — Query → Model → Documents."""


@main.command()
@click.option(
    "--input", "input_dir",
    required=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    help="Folder containing document files (.txt, .md).",
)
@click.option(
    "--out", "index_dir",
    default=Path("data/index"),
    show_default=True,
    type=click.Path(path_type=Path),
    help="Output directory for the index.",
)
@click.option(
    "--chunk-size", "max_chunk_tokens",
    default=300,
    show_default=True,
    help="Max approximate words per chunk.",
)
@click.option(
    "--overlap", "overlap_tokens",
    default=30,
    show_default=True,
    help="Overlap words between consecutive chunks.",
)
@click.option(
    "--force", is_flag=True, default=False,
    help="Force full re-indexing (ignore manifest).",
)
def ingest(
    input_dir: Path,
    index_dir: Path,
    max_chunk_tokens: int,
    overlap_tokens: int,
    force: bool,
) -> None:
    """Ingest document files and create chunk index."""
    from qmd.ingest import ingest_folder

    click.echo(f"Ingesting documents from: {input_dir}")
    click.echo(f"Index output: {index_dir}")

    try:
        chunks, stats = ingest_folder(
            input_dir=input_dir,
            index_dir=index_dir,
            max_chunk_tokens=max_chunk_tokens,
            overlap_tokens=overlap_tokens,
            force=force,
        )
    except FileNotFoundError as e:
        raise click.ClickException(str(e))

    total_files = stats['new'] + stats['changed'] + stats['unchanged']
    processed = stats['new'] + stats['changed']

    click.echo(f"\nIngestion complete:")
    click.echo(f"  Files scanned (stat only): {total_files}")
    click.echo(f"  Files read + chunked:      {processed} (new: {stats['new']}, changed: {stats['changed']})")
    click.echo(f"  Files skipped (unchanged): {stats['unchanged']}")
    if stats.get('deleted', 0) > 0:
        click.echo(f"  Files removed from index:  {stats['deleted']}")
    click.echo(f"  Total chunks: {len(chunks)}")
    click.echo(f"  Index written to: {index_dir / 'chunks.jsonl'}")

    # Generate embeddings
    try:
        from qmd.search_embed import embed_texts, save_embeddings

        click.echo(f"\nGenerating embeddings...")
        texts = [c.text for c in chunks]
        embeddings = embed_texts(texts, show_progress=True)
        emb_path = save_embeddings(index_dir, embeddings)
        click.echo(f"  Embeddings saved: {emb_path} ({embeddings.shape[0]} vectors, {embeddings.shape[1]}d)")
    except ImportError:
        click.echo(
            "\n  [skip] sentence-transformers not installed. "
            "Install with: pip install -e '.[embed]'"
        )
        click.echo("  Search will use BM25-only mode.")
    except Exception as e:
        click.echo(f"\n  [warn] Embedding generation failed: {e}")
        click.echo("  Search will use BM25-only mode.")

    # Show per-file summary
    file_counts: dict[str, int] = {}
    for c in chunks:
        file_counts[c.file_name] = file_counts.get(c.file_name, 0) + 1

    click.echo(f"\n  Per-file chunk counts:")
    for fname, count in sorted(file_counts.items()):
        click.echo(f"    {fname}: {count} chunks")


@main.command("make-sample")
@click.option(
    "--out", "output_dir",
    required=True,
    type=click.Path(path_type=Path),
    help="Output directory for sample document files.",
)
def make_sample(output_dir: Path) -> None:
    """Generate synthetic sample documents for testing."""
    from qmd.sample_data import generate_sample_data

    files = generate_sample_data(output_dir)
    click.echo(f"Created {len(files)} sample document files in {output_dir}/")
    for f in files:
        click.echo(f"  {f.name}")


@main.command()
@click.option(
    "--index", "index_dir",
    default=Path("data/index"),
    show_default=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    help="Index directory (must contain chunks.jsonl).",
)
def info(index_dir: Path) -> None:
    """Show index statistics."""
    from qmd.index_store import load_chunks

    try:
        chunks = load_chunks(index_dir)
    except FileNotFoundError as e:
        raise click.ClickException(str(e))

    file_set = {c.file_path for c in chunks}
    total_words = sum(len(c.text.split()) for c in chunks)

    click.echo(f"Index: {index_dir}")
    click.echo(f"  Files indexed: {len(file_set)}")
    click.echo(f"  Total chunks:  {len(chunks)}")
    click.echo(f"  Total words:   {total_words:,}")

    # Embedding status
    from qmd.index_store import embeddings_info
    emb_info = embeddings_info(index_dir)
    if emb_info:
        click.echo(f"  Embeddings:    {emb_info['count']} vectors ({emb_info['dimensions']}d)")
    else:
        click.echo(f"  Embeddings:    not generated")

    # Tag distribution
    tag_counts: dict[str, int] = {}
    for c in chunks:
        for t in c.tags:
            tag_counts[t] = tag_counts.get(t, 0) + 1

    if tag_counts:
        click.echo(f"  Tags (top 10):")
        for tag, count in sorted(tag_counts.items(), key=lambda x: -x[1])[:10]:
            click.echo(f"    {tag}: {count}")


@main.command()
@click.argument("query_text")
@click.option(
    "--index", "index_dir",
    default=Path("data/index"),
    show_default=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    help="Index directory (must contain chunks.jsonl).",
)
@click.option(
    "-k", "--top-k", "top_k",
    default=5,
    show_default=True,
    help="Number of results to return.",
)
@click.option(
    "--no-synth", is_flag=True, default=False,
    help="Skip LLM answer synthesis (show raw chunks only).",
)
def query(query_text: str, index_dir: Path, top_k: int, no_synth: bool) -> None:
    """Search indexed documents using hybrid BM25 + semantic ranking."""
    from qmd.index_store import load_chunks
    from qmd.hybrid import hybrid_search
    from qmd.search_embed import load_embeddings

    try:
        chunks = load_chunks(index_dir)
    except FileNotFoundError as e:
        raise click.ClickException(str(e))

    if not chunks:
        raise click.ClickException("Index is empty. Run 'qmd ingest' first.")

    results = hybrid_search(chunks, query_text, index_dir, top_k=top_k)

    embeddings = load_embeddings(index_dir)
    mode = "hybrid" if embeddings is not None and len(embeddings) == len(chunks) else "BM25-only"

    if not results:
        click.echo(f'No results for: "{query_text}"')
        return

    click.echo(f'Query: "{query_text}"  [{mode}]')
    click.echo(f"Results: {len(results)} (from {len(chunks)} chunks)\n")

    for r in results:
        snippet = r.chunk.text[:200]
        if len(r.chunk.text) > 200:
            snippet += "..."
        snippet = snippet.replace("\n", " ")

        click.echo(f"  [{r.rank}] score={r.score:.4f}  {r.chunk.file_name}")
        click.echo(f"      chunk: {r.chunk.chunk_id}")
        click.echo(f"      {snippet}")
        click.echo()

    # LLM answer synthesis
    if not no_synth:
        try:
            from qmd.synthesize import synthesize_answer

            click.echo("---")
            click.echo("Synthesizing answer...\n")
            answer, usage = synthesize_answer(query_text, results)
            click.echo(f"Answer:\n  {answer.replace(chr(10), chr(10) + '  ')}")

            sources = sorted({r.chunk.file_name for r in results})
            click.echo(f"\n  Sources: {', '.join(sources)}")
            _print_usage(usage)
        except ImportError:
            pass  # LLM deps not installed, skip silently
        except RuntimeError as e:
            click.echo(f"\n  [skip] {e}")
        except Exception as e:
            click.echo(f"\n  [warn] Synthesis failed: {e}")


@main.command()
@click.argument("query_text")
@click.option(
    "--index", "index_dir",
    default=Path("data/index"),
    show_default=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    help="Index directory (must contain chunks.jsonl).",
)
@click.option(
    "-k", "--top-k", "top_k",
    default=10,
    show_default=True,
    help="Number of results to return.",
)
def chat(query_text: str, index_dir: Path, top_k: int) -> None:
    """Interactive follow-up chat over retrieved documents."""
    import os
    from qmd.index_store import load_chunks
    from qmd.hybrid import hybrid_search
    from qmd.search_embed import load_embeddings
    from qmd.synthesize import build_context, chat_turn, detect_provider
    from qmd.search_bm25 import SearchResult as _SR

    try:
        chunks = load_chunks(index_dir)
    except FileNotFoundError as e:
        raise click.ClickException(str(e))

    if not chunks:
        raise click.ClickException("Index is empty. Run 'qmd ingest' first.")

    provider = detect_provider()
    if provider is None:
        raise click.ClickException(
            "No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env"
        )

    results = hybrid_search(chunks, query_text, index_dir, top_k=top_k)

    embeddings = load_embeddings(index_dir)
    mode = "hybrid" if embeddings is not None and len(embeddings) == len(chunks) else "BM25-only"

    if not results:
        click.echo(f'No results for: "{query_text}"')
        return

    click.echo(f'Query: "{query_text}"  [{mode}]')
    click.echo(f"Results: {len(results)} (from {len(chunks)} chunks)\n")

    for r in results:
        snippet = r.chunk.text[:200]
        if len(r.chunk.text) > 200:
            snippet += "..."
        snippet = snippet.replace("\n", " ")
        click.echo(f"  [{r.rank}] score={r.score:.4f}  {r.chunk.file_name}")
        click.echo(f"      chunk: {r.chunk.chunk_id}")
        click.echo(f"      {snippet}")
        click.echo()

    # Expand context: pull additional chunks from matched files
    context_limit = int(os.environ.get("CHAT_CONTEXT_CHUNKS", "15"))
    hit_files = {r.chunk.file_name for r in results}
    hit_chunk_ids = {r.chunk.chunk_id for r in results}

    extra = [
        _SR(chunk=c, score=0.0, rank=0)
        for c in chunks
        if c.file_name in hit_files and c.chunk_id not in hit_chunk_ids
    ]

    # Combine: original ranked results + extra chunks, capped at limit
    all_context = list(results) + extra
    all_context = all_context[:context_limit]

    click.echo(f"  Context: {len(all_context)} chunks from {len(hit_files)} file(s)\n")

    # Build context and start chat
    context = build_context(all_context)
    conversation: list[dict] = []

    click.echo("---")
    click.echo("Thinking...\n")
    answer, usage = chat_turn(query_text, conversation, context, provider=provider)
    click.echo(f"Answer:\n  {answer.replace(chr(10), chr(10) + '  ')}")

    sources = sorted(hit_files)
    click.echo(f"\n  Sources: {', '.join(sources)}")
    _print_usage(usage)
    click.echo()

    # Interactive loop
    while True:
        try:
            user_input = click.prompt("You", default="", show_default=False).strip()
        except (EOFError, KeyboardInterrupt):
            click.echo("\nBye!")
            break

        if not user_input or user_input.lower() in ("exit", "quit", "q"):
            click.echo("Bye!")
            break

        click.echo()
        reply, usage = chat_turn(user_input, conversation, context, provider=provider)
        click.echo(f"Answer:\n  {reply.replace(chr(10), chr(10) + '  ')}")
        _print_usage(usage)
        click.echo()


if __name__ == "__main__":
    main()
