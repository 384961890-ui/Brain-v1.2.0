"""LLM answer synthesis from retrieved chunks (RAG)."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

from qmd.search_bm25 import SearchResult

# Load .env from project root
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SYSTEM_PROMPT = (
    "You are an assistant that answers questions based on document excerpts. "
    "Answer the user's question using ONLY the provided context. "
    "If the context doesn't contain enough information, say so. "
    "Be concise and direct. Cite which source file(s) your answer comes from."
)

CHAT_SYSTEM_PROMPT = (
    "The user will share document excerpts as context. Answer their questions directly "
    "using both the documents and your general knowledge. Be concise."
)


def detect_provider() -> str | None:
    """Detect which LLM provider to use based on available API keys.

    Returns 'openai', 'anthropic', or None.
    """
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    return None


def build_context(results: list[SearchResult]) -> str:
    """Format retrieved chunks into a context string for the LLM."""
    parts = []
    for r in results:
        parts.append(
            f"[Source: {r.chunk.file_name}, chunk: {r.chunk.chunk_id}]\n"
            f"{r.chunk.text}"
        )
    return "\n\n---\n\n".join(parts)


def synthesize_answer(
    query: str,
    results: list[SearchResult],
    provider: str | None = None,
) -> str:
    """Generate an LLM-synthesized answer from retrieved chunks.

    Args:
        query: The user's question.
        results: Retrieved SearchResult objects with chunk text.
        provider: 'openai', 'anthropic', or None (auto-detect).

    Returns:
        The synthesized answer string.

    Raises:
        RuntimeError: If no API key is configured.
        ImportError: If the required SDK is not installed.
    """
    if provider is None:
        provider = detect_provider()

    if provider is None:
        raise RuntimeError(
            "No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env"
        )

    context = build_context(results)
    messages = [{"role": "user", "content": f"Context:\n{context}\n\nQuestion: {query}"}]

    if provider == "openai":
        reply, usage = _call_openai(messages)
        return reply, usage
    elif provider == "anthropic":
        reply, usage = _call_anthropic(messages)
        return reply, usage
    else:
        raise ValueError(f"Unknown provider: {provider}")


def chat_turn(
    user_message: str,
    conversation: list[dict],
    context: str,
    provider: str | None = None,
) -> str:
    """Send a follow-up message in a multi-turn conversation.

    Args:
        user_message: The user's follow-up question.
        conversation: Mutable list of {"role": ..., "content": ...} dicts.
            Updated in-place with the new user and assistant messages.
        context: The document context string (from build_context).
        provider: 'openai', 'anthropic', or None (auto-detect).

    Returns:
        The assistant's response string.
    """
    if provider is None:
        provider = detect_provider()
    if provider is None:
        raise RuntimeError(
            "No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env"
        )

    # On the first turn, prepend the document context
    if not conversation:
        full_message = f"Context:\n{context}\n\nQuestion: {user_message}"
    else:
        full_message = user_message

    conversation.append({"role": "user", "content": full_message})

    if provider == "openai":
        reply, usage = _call_openai(conversation, system_prompt=CHAT_SYSTEM_PROMPT)
    elif provider == "anthropic":
        reply, usage = _call_anthropic(conversation, system_prompt=CHAT_SYSTEM_PROMPT)
    else:
        raise ValueError(f"Unknown provider: {provider}")

    conversation.append({"role": "assistant", "content": reply})
    return reply, usage


def _call_openai(messages: list[dict], system_prompt: str = SYSTEM_PROMPT) -> str:
    """Call OpenAI API with a full message history."""
    from openai import OpenAI

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    client = OpenAI()
    kwargs = dict(
        model=model,
        messages=[{"role": "system", "content": system_prompt}] + messages,
        temperature=0.2,
    )
    if model.startswith("gpt-5"):
        kwargs["max_completion_tokens"] = 1024
    else:
        kwargs["max_tokens"] = 1024
    response = client.chat.completions.create(**kwargs)
    usage = response.usage
    return response.choices[0].message.content, {
        "output_tokens": usage.completion_tokens,
        "input_tokens": usage.prompt_tokens,
    }


def _call_anthropic(messages: list[dict], system_prompt: str = SYSTEM_PROMPT) -> str:
    """Call Anthropic API with a full message history."""
    from anthropic import Anthropic

    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")
    client = Anthropic()
    response = client.messages.create(
        model=model,
        max_tokens=1024,
        system=system_prompt,
        messages=messages,
        temperature=0.2,
    )
    return response.content[0].text, {
        "output_tokens": response.usage.output_tokens,
        "input_tokens": response.usage.input_tokens,
    }
