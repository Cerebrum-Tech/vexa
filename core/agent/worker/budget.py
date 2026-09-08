"""budget.py — the context budget every prompt this worker sends is held to.

A deployment's model has a finite context window, and a meeting has no finite length. Left
unbounded the two meet at the worst moment: the post-meeting report, on the longest meeting, is the
request that overflows — and an overflow is not a degraded report, it is no report at all.

So the budget is explicit (``VEXA_LLM_CONTEXT_TOKENS``, default 8000) and enforced HERE rather than
hoped for. Two shapes use it:

  * :func:`fit` — trim one blob to the budget (the live card beat's transcript window).
  * :func:`pack` — split many items into chunks that each fit (the report's map step).

**The estimate is deliberately pessimistic.** We do not ship a tokenizer: the deployment's model is
chosen at runtime (this one runs gemma behind an OpenAI-compatible endpoint) and vendoring a
tokenizer that disagrees with it would be a more confident lie than a heuristic. ``chars/3.2``
over-counts English (~4 chars/token) and roughly matches the Turkish this deployment writes, where
agglutinative words and non-ASCII characters both push the ratio down. Over-counting spends budget
we had; under-counting loses the report. Only one of those is recoverable.
"""
from __future__ import annotations

import os
from typing import Callable, Iterable, TypeVar

#: Fallback when ``VEXA_LLM_CONTEXT_TOKENS`` is unset or unreadable.
DEFAULT_CONTEXT_TOKENS = 8000

#: Characters per token. See the module docstring — pessimistic on purpose.
_CHARS_PER_TOKEN = 3.2

T = TypeVar("T")


def estimate_tokens(text: str) -> int:
    """A pessimistic token estimate for ``text``. Never returns 0 for non-empty input."""
    if not text:
        return 0
    return max(1, int(len(text) / _CHARS_PER_TOKEN) + 1)


def context_tokens(env: "dict[str, str] | None" = None) -> int:
    """The deployment's per-request context budget (``VEXA_LLM_CONTEXT_TOKENS``).

    An unset, unparseable or non-positive value falls back to the default rather than raising: a bad
    number in the environment must cost a meeting its tuning, never its report."""
    raw = (env if env is not None else os.environ).get("VEXA_LLM_CONTEXT_TOKENS", "")
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return DEFAULT_CONTEXT_TOKENS
    return value if value > 0 else DEFAULT_CONTEXT_TOKENS


def fit(text: str, budget_tokens: int) -> str:
    """``text`` trimmed to ``budget_tokens``, keeping the END.

    The tail is kept because in a transcript window the newest lines are the ones the turn is about;
    in a summary, the conclusions are at the bottom. Trimming is line-aligned (a half-line is worse
    than a missing one) and the trim is ANNOUNCED in the returned text, so the model is never
    silently handed a fragment it will treat as the whole."""
    if budget_tokens <= 0 or estimate_tokens(text) <= budget_tokens:
        return text
    marker = "[… önceki satırlar bağlam sınırı nedeniyle atlandı …]\n"
    room = budget_tokens - estimate_tokens(marker)
    if room <= 0:
        return marker
    lines = text.splitlines(keepends=True)
    kept: list[str] = []
    used = 0
    for line in reversed(lines):
        cost = estimate_tokens(line)
        if used + cost > room:
            break
        kept.append(line)
        used += cost
    if not kept:  # one line alone exceeds the room — cut it by characters rather than return nothing
        return marker + text[-int(room * _CHARS_PER_TOKEN):]
    return marker + "".join(reversed(kept))


def pack(items: Iterable[T], render: Callable[[T], str], budget_tokens: int) -> "list[list[T]]":
    """Split ``items`` into consecutive chunks whose rendered size each fits ``budget_tokens``.

    Order is preserved and nothing is dropped — that is the difference between this and :func:`fit`,
    and the reason the report's map step can claim to have seen the whole meeting. An item that
    alone exceeds the budget still gets its own chunk (the caller's ``fit`` handles the overflow at
    render time); refusing it would silently lose a line of the transcript."""
    budget = max(1, budget_tokens)
    chunks: "list[list[T]]" = []
    current: "list[T]" = []
    used = 0
    for item in items:
        cost = estimate_tokens(render(item))
        if current and used + cost > budget:
            chunks.append(current)
            current, used = [], 0
        current.append(item)
        used += cost
    if current:
        chunks.append(current)
    return chunks
