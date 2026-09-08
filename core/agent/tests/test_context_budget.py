"""The context budget every prompt this worker sends is held to (worker/budget.py + the report's
map→reduce evidence builder).

A meeting has no maximum length and the model's context does. These are the assertions that make
"held to 8000 tokens" a fact rather than an intention — including the one that matters most: the
post-meeting report's prompt stays inside the budget for a meeting far longer than the budget, and
still carries evidence drawn from EVERY part of it.
"""
from __future__ import annotations

import json

import pytest

from worker.budget import (
    DEFAULT_CONTEXT_TOKENS,
    context_tokens,
    estimate_tokens,
    fit,
    pack,
)
from worker.meeting import (
    build_card_prompt,
    build_digest_prompt,
    build_meeting_doc_prompt,
    note_lines,
    summarize_notes,
)


class FakeCompletion:
    """A CompletionPort double that returns a compact digest per call, and records every prompt."""

    def __init__(self, reply: str = "KONULAR:\n- bir konu", fail_on: "set[int] | None" = None):
        self.prompts: list[str] = []
        self._reply = reply
        self._fail_on = fail_on or set()

    def complete(self, prompt, *, system=None, model=None):
        self.prompts.append(prompt)
        if len(self.prompts) in self._fail_on:
            raise RuntimeError("upstream 503")

        class _R:
            text = self._reply
            model = "fake"
        return _R()


def notes(n: int, *, words: int = 40) -> list[dict]:
    return [{"id": f"s{i}", "speaker": f"Konuşmacı {i % 3}",
             "text": " ".join([f"cümle{i}"] * words)} for i in range(n)]


# ── the estimator + the two shapes ───────────────────────────────────────────────────────────────
def test_the_budget_comes_from_the_env_and_survives_nonsense():
    assert context_tokens({}) == DEFAULT_CONTEXT_TOKENS
    assert context_tokens({"VEXA_LLM_CONTEXT_TOKENS": "8000"}) == 8000
    # A bad number costs the deployment its tuning, never its report.
    for bad in ("", "abc", "0", "-5", None):
        assert context_tokens({"VEXA_LLM_CONTEXT_TOKENS": bad}) == DEFAULT_CONTEXT_TOKENS


def test_the_estimate_is_pessimistic_rather_than_clever():
    """Over-counting spends budget we had; under-counting loses the report. Only one is recoverable,
    so the estimate must never read FEWER tokens than a real tokenizer would for ordinary prose."""
    text = "The meeting has ended and the report must be written."
    words = len(text.split())
    assert estimate_tokens(text) >= words          # never under a word-count floor
    assert estimate_tokens("") == 0
    assert estimate_tokens("x") >= 1
    # Turkish costs more per character, and the estimate must not be blind to that.
    assert estimate_tokens("görüşülen konular ve alınan kararlar") >= 8


def test_fit_keeps_the_newest_lines_and_says_that_it_trimmed():
    text = "\n".join(f"Konuşmacı: satır {i}" for i in range(400))
    out = fit(text, 100)
    assert estimate_tokens(out) <= 100
    assert "satır 399" in out          # the tail — what the turn is about — survives
    assert "satır 0" not in out
    assert "atlandı" in out.splitlines()[0]  # the trim is announced, not silent


def test_fit_is_a_no_op_when_it_already_fits():
    text = "Konuşmacı: kısa bir satır"
    assert fit(text, 8000) == text


def test_pack_drops_nothing_and_keeps_order():
    items = [f"satır {i} " * 30 for i in range(300)]
    chunks = pack(items, lambda x: x, 400)
    assert len(chunks) > 1
    assert [i for c in chunks for i in c] == items      # order preserved, nothing lost
    for chunk in chunks[:-1]:
        assert estimate_tokens("".join(chunk)) <= 400 + estimate_tokens(items[0])


# ── the live card beat ───────────────────────────────────────────────────────────────────────────
def test_the_card_beat_prompt_stays_inside_the_budget(monkeypatch):
    """A re-armed worker replaying from a cursor, or a long silence then a burst, hands the beat far
    more lines than a steady meeting does. The frame must absorb that."""
    monkeypatch.setenv("VEXA_LLM_CONTEXT_TOKENS", "2000")
    lines = "\n".join(f"[pass 1/3 id=s{i} speaker=Ayşe] " + "söz " * 40 for i in range(500))
    prompt = build_card_prompt(lines, ["person", "company"])
    assert estimate_tokens(prompt) <= 2000
    assert "id=s499" in prompt          # the newest lines are the ones kept


# ── the report's evidence: map → reduce ──────────────────────────────────────────────────────────
def test_a_meeting_that_fits_is_passed_through_verbatim():
    """The raw transcript is always better evidence than a digest of it — so when it is affordable
    there is no map step, and no model call at all."""
    completion = FakeCompletion()
    evidence = summarize_notes(notes(5), budget_tokens=8000, completion=completion,
                               report_language="tr")
    assert completion.prompts == []                     # nothing was summarized
    assert evidence == note_lines(notes(5))


def test_a_long_meeting_is_digested_in_chunks_that_fit():
    completion = FakeCompletion()
    evidence = summarize_notes(notes(400), budget_tokens=1500, completion=completion,
                               report_language="tr")
    assert len(completion.prompts) > 1                  # it mapped
    assert estimate_tokens(evidence) <= 1500            # and the result fits
    # every chunk prompt announced its place, so no part of the meeting is presented as the whole
    assert all("PART" in p for p in completion.prompts)
    parts = {p.split("PART ")[1].split(" of ")[0] for p in completion.prompts}
    assert parts == {str(i) for i in range(1, len(completion.prompts) + 1)}


def test_every_part_of_the_meeting_reaches_the_map_step():
    """The claim that distinguishes map-reduce from truncation: the END of a long meeting — where
    the decisions usually are — is summarized too, not dropped."""
    completion = FakeCompletion()
    summarize_notes(notes(400), budget_tokens=1500, completion=completion, report_language="tr")
    seen = "\n".join(completion.prompts)
    assert "cümle0 " in seen
    assert "cümle399" in seen


def test_a_failed_digest_costs_detail_not_a_stretch_of_the_meeting():
    """One 503 must not silently delete a quarter of the meeting from its own report."""
    completion = FakeCompletion(fail_on={2})
    evidence = summarize_notes(notes(400), budget_tokens=1500, completion=completion,
                               report_language="tr")
    assert estimate_tokens(evidence) <= 1500
    assert "cümle" in evidence          # the failed chunk fell back to its own transcript


def test_the_digest_prompt_forbids_inventing_a_decision():
    prompt = build_digest_prompt("Ayşe: merhaba", part=1, total=3, report_language="tr")
    assert "PART 1 of 3" in prompt
    assert "never infer" in prompt
    assert "omit this label entirely" in prompt      # no decision ⇒ no heading, not a guess


# ── the whole report request ─────────────────────────────────────────────────────────────────────
def _doc_prompt(evidence: str) -> str:
    return build_meeting_doc_prompt(
        [{"kind": "person", "title": "Ayşe"}], native="abc-defg-hij", meeting_id="42",
        session_uid="42", platform="google_meet", date="2026-09-08", title="Haftalık",
        report_language="tr", evidence=evidence,
    )


def test_the_report_request_fits_the_budget_for_a_meeting_that_does_not():
    """The end-to-end claim. 400 notes is well past 8000 tokens of raw transcript; the request that
    actually goes out stays inside it."""
    completion = FakeCompletion()
    frame = estimate_tokens(_doc_prompt(""))
    evidence = summarize_notes(notes(400), budget_tokens=8000 - frame, completion=completion,
                               report_language="tr")
    assert estimate_tokens(note_lines(notes(400))) > 8000      # the meeting itself does not fit
    assert estimate_tokens(_doc_prompt(evidence)) <= 8000      # the request does


def test_the_report_prompt_carries_its_own_frontmatter_and_forbids_reading():
    """The budget is only real if the turn never opens the transcript file — a file read is context
    we neither see nor can cap. So the prompt must be self-contained."""
    prompt = _doc_prompt("Ayşe: karar aldık.")
    assert "id: abc-defg-hij" in prompt and "date: 2026-09-08" in prompt
    assert "Do NOT read any other file" in prompt
    assert "Ayşe: karar aldık." in prompt
    for heading in ("## Özet", "## Alınan Kararlar", "## Aksiyon Maddeleri"):
        assert heading in prompt          # the terminal's recap contract survives the rewrite


def test_an_evidence_less_meeting_says_so_rather_than_leaving_a_hole():
    assert "no transcript evidence" in _doc_prompt("")
