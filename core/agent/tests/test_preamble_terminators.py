"""The stored-chat STRIP CONTRACT between the worker's prompt preambles and the terminal.

Server-side grounding is part of the stored prompt, so the terminal cuts each known preamble out of a
stored turn start→terminator before rendering it as the user's words (``CONTEXT_BLOCKS`` in
clients/terminal/src/surfaces/chat.tsx). The terminator is the block's CLOSING SENTENCE: a rule
appended after it survives the cut and is shown to the user as something they typed.

These tests pin that closing sentence for every preamble ``worker.engine`` emits, in every supported
turn language, and replay the terminal's cut over the real preamble stack. The regexes below mirror
CONTEXT_BLOCKS; JS ``^`` without the ``m`` flag is start-of-string, hence ``\\A``.
"""
import re

from worker.engine import (
    _LANGUAGE_DIRECTIVES,
    DEFAULT_TURN_LANGUAGE,
    kg_links_preamble,
    language_directive,
    mounts_preamble,
)

KG_TERMINATOR = "or use plain text."
MOUNTS_TERMINATOR = "do not guess or invent mount paths."

# [start, terminator] pairs, mirroring CONTEXT_BLOCKS (clients/terminal/src/surfaces/chat.tsx).
CONTEXT_BLOCKS = [
    (r"\A## Referencing knowledge \(always\)", re.escape(KG_TERMINATOR) + r"\s*"),
    (r"\A## Your mounted workspaces", re.escape(MOUNTS_TERMINATOR) + r"\s*"),
]

LANGUAGES = [DEFAULT_TURN_LANGUAGE, *_LANGUAGE_DIRECTIVES]

MOUNT_STACK = [
    {"slug": "_global", "path": "/w/_global", "role": "global", "write": False, "primary": False},
    {"slug": "seed", "path": "/w/u1", "role": "private", "write": True, "primary": True},
]


def strip_context_blocks(raw: str) -> str:
    """The terminal's fallback cut (``stripContextBlocks``) for chats stored without the boundary
    sentinel: repeatedly, if the text OPENS with a known block, drop everything through that block's
    terminator. A block whose terminator is no longer its closing sentence stops the loop dead — the
    residue, and every block behind it, then renders as the user's own words."""
    text, guard = raw, 0
    while guard < 12:
        guard += 1
        for start, end in CONTEXT_BLOCKS:
            if re.search(start, text):
                m = re.search(end, text)
                if m:
                    text = text[m.end():].lstrip()
                    break
        else:
            break
    return raw if text == raw else (text.strip() or raw)


def test_every_preamble_closes_on_the_terminator_the_terminal_anchors_on():
    """The pin: a rule appended below the closing sentence is what breaks the strip, so assert the
    closing sentence IS the terminator — in every turn language, since the directive adds lines."""
    for lang in LANGUAGES:
        assert kg_links_preamble(lang).rstrip().endswith(KG_TERMINATOR), lang
        assert mounts_preamble(MOUNT_STACK, lang).rstrip().endswith(MOUNTS_TERMINATOR), lang


def test_the_terminal_cuts_the_whole_english_preamble_stack_off_a_stored_turn():
    """End to end over the REAL stack the worker prepends: only the user's words survive."""
    raw = kg_links_preamble() + mounts_preamble(MOUNT_STACK) + "what did we decide?"
    assert strip_context_blocks(raw) == "what did we decide?"


def test_a_translated_turn_cuts_the_same_once_its_directive_block_is_consumed():
    """The output-language directive is its own leading block. Behind it, the kg-links and mount
    declarations still cut cleanly — the language lines ride ABOVE each block's terminator, never
    after it."""
    for lang in _LANGUAGE_DIRECTIVES:
        directive = language_directive(lang)
        raw = kg_links_preamble(lang) + mounts_preamble(MOUNT_STACK, lang) + "ne karar verdik?"
        assert raw.startswith(directive)
        assert strip_context_blocks(raw[len(directive):]) == "ne karar verdik?", lang


def test_english_is_the_identity_so_no_language_line_reaches_its_prompts():
    """English resolves to no directive, so nothing language-specific is emitted: the default, "en",
    a blank value and an unknown code all produce the SAME bytes, and neither the directive block nor
    the mount-identifier line it pulls in appears anywhere in them."""
    assert language_directive("en") == ""
    assert language_directive("") == "" and language_directive("de") == ""
    for lang in ("en", "EN", " en ", "", "de"):
        assert kg_links_preamble(lang) == kg_links_preamble(), lang
        assert mounts_preamble(MOUNT_STACK, lang) == mounts_preamble(MOUNT_STACK), lang
    english = kg_links_preamble() + mounts_preamble(MOUNT_STACK)
    assert "## Output language" not in english
    assert "quote them EXACTLY as written" not in english   # the mount line that rides with a directive
