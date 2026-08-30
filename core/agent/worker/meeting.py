"""meeting.py — the live MEETING copilot of the in-container agent harness.

Consumes the meeting's ``transcript.v1`` Stream, gates cheaply, cleans the transcript + surfaces
proactive cards via a DIRECT ``CompletionPort`` call (a card beat is a pure prompt→text turn — no
tools, no subprocess, no workspace memory), and (on ``session_end``) authors the post-meeting kg
meeting entity via the governed harness turn (``run_turn_over_workspace``).

Imports the GENERIC helpers it needs from ``worker.engine`` (one direction); the engine imports the
meeting entry functions only inside ``main()`` (function-local) to avoid an import cycle.
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Callable, Iterator

from llm import (
    LLMAuthError,
    auth_error_event,
    completion_from_env,
    looks_like_auth_failure,
    model_error_event,
)
from shared.agent_config import (
    DEFAULT_CARD_KINDS,
    DEFAULT_POLISH_RULES,
    DEFAULT_TAG_RULES,
)
from worker.engine import _Stream
from worker.engine import run_turn_over_workspace as _engine_run_turn_over_workspace

# Back-compat aliases (pre-llm-split names the worker.worker shim re-exports).
_auth_error_event = auth_error_event
_model_error_event = model_error_event


def run_turn_over_workspace(*args, **kwargs):
    """Indirection so a test that patches ``worker.worker.run_turn_over_workspace`` reaches the call
    sites in this module (the harness was historically one module). Resolves the name through the
    ``worker.worker`` shim at CALL time, falling back to the engine implementation."""
    import worker.worker as _w
    fn = getattr(_w, "run_turn_over_workspace", _engine_run_turn_over_workspace)
    if fn is run_turn_over_workspace:  # avoid self-recursion if the shim points back here
        fn = _engine_run_turn_over_workspace
    yield from fn(*args, **kwargs)

log = logging.getLogger("agent_api.worker")


# ── meeting mode: consume the transcript Stream, gate, emit proactive cards ───────────────────────

# build_card_prompt is a THIN COMPOSER: the MECHANISM (the transcript-window framing + the strict JSON
# shape the parser depends on) lives here in code; the POLICY (how to polish each line, and what to tag)
# is INJECTED from the workspace-governed MeetingConfig.polish_rules / .tag_rules — so a user can change
# copilot behavior by prompting the agent to edit agents/meeting.md, no redeploy.

# The fixed frame around the workspace policy. `{polish}` / `{tags}` are the governed rules; `{kinds}` is
# the wanted card kinds; `{steering}` is the (optional) free-text steering section. The frame is ENGLISH
# because it carries the machine-readable contract (the strict JSON object `parse_notes`/`parse_cards`
# consume) and a small instruct model follows that contract best in the language it was tuned on; the
# OUTPUT language is not left to inference — the frame states it, and the governed policy repeats it.
_CARD_FRAME = (
    "You are a live meeting copilot watching a conversation in real time. Here is the mutable transcript "
    "processing window. Each line is sent through at most three passes; pass 1 is fresh, pass 2 should "
    "repair obvious ASR/name/entity errors, and pass 3 should be the final clean version before the line "
    "freezes and leaves this window.\n\n{lines}\n\n"
    "Return a processed transcript plus tag cards. For each input line, emit one note with the SAME id "
    "and speaker, following the POLISH RULES below.\n\n"
    "## Polish rules (governed by this workspace)\n{polish}\n\n"
    "Do not create topic headings. Set chapter to an empty string unless the source text itself gives a "
    "literal section title.\n\n"
    "## Tag rules (governed by this workspace)\n{tags}\n\n"
    "Emit tags ONLY as cards of these kinds: {kinds}. Do not use any other kind.\n\n"
    "## Output language\n"
    "This deployment's output language is TURKISH. Every value a user reads is Turkish prose: each "
    "note's `text` and every card `body`. A card `title` is the entity's own name — copy it verbatim, "
    "never translated. The JSON keys, the note ids, the speaker names and the card kinds are literals: "
    "reproduce them exactly as they are given here. If a speaker spoke another language, keep that "
    "speaker's own words rather than translating them.\n\n"
    "Respond with ONLY this JSON object (no prose, no markdown fence, and do NOT write any files):\n"
    "{{\"notes\":[{{\"id\":\"<input id>\",\"speaker\":\"<speaker>\",\"chapter\":\"\",\"text\":\"<clean one-line note>\"}}],"
    "\"cards\":[{{\"kind\":\"<one of {kinds}>\",\"title\":\"<short>\",\"body\":\"<one line>\",\"actionable\":true}}]}}\n"
    "Use an empty cards array if these specific lines add no tags.{steering}"
)

# Appended to the frame only when the workspace config carries non-empty steering.
_STEERING_SECTION = (
    "\n\n## Standing instructions from this workspace\n"
    "Follow these workspace-set instructions about what to watch / ignore / tone:\n\n{steering}\n"
)


def build_card_prompt(
    lines: str,
    card_kinds: list[str],
    steering: str = "",
    *,
    polish_rules: str = DEFAULT_POLISH_RULES,
    tag_rules: str = DEFAULT_TAG_RULES,
) -> str:
    """Compose the copilot prompt: inject the workspace-governed ``polish_rules`` + ``tag_rules`` (the
    POLICY) and the wanted ``card_kinds`` around the transcript ``lines`` (the MECHANISM frame), plus the
    optional ``steering`` section. Changing a governed rule (via agents/meeting.md) changes the prompt."""
    section = _STEERING_SECTION.format(steering=steering.strip()) if steering.strip() else ""
    return _CARD_FRAME.format(
        lines=lines,
        kinds=", ".join(card_kinds),
        polish=(polish_rules or DEFAULT_POLISH_RULES).strip(),
        tags=(tag_rules or DEFAULT_TAG_RULES).strip(),
        steering=section,
    )


def _extract_json_value(reply: str | None):
    if not reply:
        return None
    text = reply.strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    import re

    matches = []
    for pattern in (r"\{.*\}", r"\[.*\]"):
        m = re.search(pattern, reply, re.DOTALL)
        if m:
            matches.append((m.start(), m.group(0)))
    for _start, raw in sorted(matches, key=lambda item: item[0]):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def parse_cards(reply: str | None, card_kinds: list[str] | None = None) -> list[dict]:
    """Tolerantly pull the JSON card array out of the agent's reply (it may wrap it in prose/fences).
    When ``card_kinds`` is given, only cards of those kinds are kept."""
    value = _extract_json_value(reply)
    if isinstance(value, dict):
        arr = value.get("cards") or []
    elif isinstance(value, list):
        arr = value
    else:
        return []
    allowed = {k.lower() for k in card_kinds} if card_kinds else None
    out = []
    for c in arr:
        if not (isinstance(c, dict) and c.get("title") and c.get("kind")):
            continue
        if allowed is not None and str(c.get("kind")).lower() not in allowed:
            continue
        out.append(c)
    return out


def parse_notes(
    reply: str | None,
    stage_by_id: dict[str, int] | None = None,
    segment_by_id: dict[str, dict] | None = None,
) -> list[dict]:
    """Pull processed transcript notes from the copilot JSON object."""
    value = _extract_json_value(reply)
    if not isinstance(value, dict):
        return []
    arr = value.get("notes") or []
    if not isinstance(arr, list):
        return []
    stages = stage_by_id or {}
    segments = segment_by_id or {}
    out = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        note_id = str(item.get("id") or "").strip()
        if segments and note_id not in segments:
            continue
        text = _first_person_note_text(str(item.get("text") or ""))
        if not note_id or not text:
            continue
        stage = int(item.get("pass") or stages.get(note_id) or 1)
        source = segments.get(note_id) or {}
        note = {
            "id": note_id,
            "speaker": str(item.get("speaker") or "").strip() or "Speaker",
            "chapter": str(item.get("chapter") or item.get("chapter_title") or "").strip(),
            "text": text,
            "pass": max(1, min(3, stage)),
            "frozen": stage >= 3,
        }
        ts = item.get("t", item.get("ts", source.get("start")))
        if ts is not None:
            note["t"] = ts
        out.append(note)
    return out


def _first_person_note_text(text: str) -> str:
    out = " ".join(text.split()).strip()
    rewrites = [
        (re.compile(r"^Speaker\s+mentions\s+using\s+(.+?)\s+and\s+finding\s+(.+?)\s+appealing\.?$", re.I), r"I use \1 and find \2 appealing."),
        (re.compile(r"^Speaker\s+(?:describes|frames)\s+(.+?)\s+as\s+", re.I), r"\1 is "),
        (re.compile(r"^Speaker\s+read\s+more\s+about\s+", re.I), "I read more about "),
        (re.compile(r"^Speaker\s+(?:expresses|has)\s+fear\s+that\s+", re.I), "I'm afraid "),
        (re.compile(r"^Speaker\s+(?:initially\s+)?thought\s+", re.I), "I initially thought "),
        (re.compile(r"^Speaker\s+(?:believes|thinks)\s+(?:that\s+)?", re.I), ""),
        (re.compile(r"^Speaker\s+(?:announces|states|says|notes|reports|explains|emphasizes)\s+(?:that\s+)?", re.I), ""),
        (re.compile(r"^Speaker\s+will\s+", re.I), "I will "),
        (re.compile(r"^Speaker\s+wants\s+", re.I), "I want "),
        (re.compile(r"^Speaker\s+needs\s+", re.I), "I need "),
        (re.compile(r"^Speaker\s+plans\s+to\s+", re.I), "I plan to "),
        (re.compile(r"^Speaker\s+asks\s+", re.I), "I ask "),
        (re.compile(r"^Speaker\s+", re.I), ""),
    ]
    for pattern, replacement in rewrites:
        next_out = pattern.sub(replacement, out, count=1).strip()
        if next_out != out:
            out = next_out
            break
    return out[:1].upper() + out[1:] if out else out


def fallback_processed_notes(segments: list[dict], stage_by_id: dict[str, int] | None = None) -> list[dict]:
    stages = stage_by_id or {}
    notes: list[dict] = []
    for index, segment in enumerate(segments):
        note_id = str(segment.get("segment_id") or segment.get("id") or f"segment-{index + 1}").strip()
        text = _first_person_note_text(str(segment.get("text") or ""))
        if not note_id or not text:
            continue
        stage = max(1, min(3, int(segment.get("rewrite_pass") or stages.get(note_id) or 1)))
        note = {
            "id": note_id,
            "speaker": str(segment.get("speaker") or "").strip() or "Speaker",
            "chapter": "Live Transcript",
            "text": text,
            "pass": stage,
            "frozen": stage >= 3,
        }
        ts = segment.get("start")
        if ts is not None:
            note["t"] = ts
        notes.append(note)
    return notes


def meeting_card_turn(
    work: Path, segments: list[dict], *, model: str | None = None,
    card_kinds: list[str] | None = None, steering: str = "",
    polish_rules: str = DEFAULT_POLISH_RULES, tag_rules: str = DEFAULT_TAG_RULES,
    completion=None,
) -> Iterator[dict]:
    """One copilot beat: polish the recent transcript window + emit a proactive card per salient
    finding, via ONE direct ``CompletionPort`` call. A beat is a pure prompt→text turn — everything
    it needs is already in the prompt window, so there is no harness, no subprocess, and no
    workspace memory (the old tool-granted turn let the model explore the KG every beat — the
    dominant per-beat latency; a direct completion also never auto-loads workspace conventions, so
    steering lives EXCLUSIVELY in agents/meeting.md). The wanted ``card_kinds`` + workspace
    ``steering`` shape the prompt, and cards are filtered to the allowed kinds.

    ``completion`` is injectable; by default it resolves through the ``worker.worker``
    ``completion_factory`` seam (env-selected adapter, ``VEXA_LLM_PROVIDER``)."""
    kinds = card_kinds or list(DEFAULT_CARD_KINDS)
    segment_by_id = {str(s.get("segment_id") or s.get("id") or ""): s for s in segments}
    stage_by_id = {seg_id: int(s.get("rewrite_pass") or 1) for seg_id, s in segment_by_id.items()}
    lines = "\n".join(
        f"[pass {int(s.get('rewrite_pass') or 1)}/3 id={s.get('segment_id') or s.get('id') or '?'} "
        f"speaker={s.get('speaker', '?')}] {s.get('text', '')}"
        for s in segments
    )
    prompt = build_card_prompt(lines, kinds, steering, polish_rules=polish_rules, tag_rules=tag_rules)
    # We DON'T forward raw model output as turn events — the JSON reply would leak into the UI as a
    # "note"; the meeting feed wants only the parsed notes/cards.
    try:
        if completion is None:
            import worker.worker as _w
            completion = getattr(_w, "completion_factory", completion_from_env)()
        reply = completion.complete(prompt, model=model).text
    except LLMAuthError as exc:
        # Fail LOUD on a 401/auth mismatch: a distinct auth-error (provider host + the
        # BASE_URL-vs-KEY fix) instead of the opaque generic model-error (WS1b).
        yield auth_error_event(exc, model=model, stage="meeting-card")
        return
    except Exception as exc:
        if looks_like_auth_failure(exc):
            yield auth_error_event(exc, model=model, stage="meeting-card")
            return
        yield model_error_event(exc, model=model, stage="meeting-card")
        return
    notes = parse_notes(reply, stage_by_id, segment_by_id)
    cards = parse_cards(reply, kinds)
    if segments and not notes:
        yield _model_error_event("model response did not include processed transcript notes", model=model, stage="meeting-card")
        notes = fallback_processed_notes(segments, stage_by_id)
    for note in notes:
        yield {"type": "note", "note": note}
    for card in cards:
        yield {"type": "card", "card": card}


# ── Auth-B/#3(a): persist the processed transcript to the workspace, INCREMENTALLY ────────────────
# As the worker emits 1:1 cleaned `proc:meeting` notes, it ALSO upserts a per-meeting workspace file at
# kg/entities/meeting/<native>.md so a chat agent focused on the meeting can `Read` it and answer "what's
# the meeting about" — WITHOUT waiting for the post-meeting doc turn. The write is idempotent: each line
# is keyed by its note id (== segment_id) with an HTML-comment marker, so a refining pass UPDATES the
# line in place rather than duplicating it. This reuses the same VISIBLE, git-tracked kg/entities/meeting
# path the post-meeting doc turn authors (the doc turn later distills a summary into the SAME tree).

_PROC_LINE_RE = re.compile(r"^<!-- id:(?P<id>.*?) -->", )


def render_meeting_transcript(meta: dict, notes: list[dict]) -> str:
    """Render the per-meeting transcript file: YAML frontmatter (type/id/title/… from ``meta``), a
    Speakers list, and a Transcript section with one id-keyed line per note. Pure + deterministic so the
    upsert is testable offline."""
    speakers: list[str] = []
    for n in notes:
        sp = str(n.get("speaker") or "Speaker").strip() or "Speaker"
        if sp not in speakers:
            speakers.append(sp)
    fm_keys = ("type", "id", "title", "meeting_id", "session_uid", "platform", "date")
    fm_lines = [f"{k}: {meta[k]}" for k in fm_keys if meta.get(k) is not None]
    parts = ["---", *fm_lines, "---", "", "## Speakers", ""]
    parts += [f"- {sp}" for sp in speakers] or ["- (none yet)"]
    parts += ["", "## Transcript", ""]
    for n in notes:
        nid = str(n.get("id") or "").strip()
        sp = str(n.get("speaker") or "Speaker").strip() or "Speaker"
        text = " ".join(str(n.get("text") or "").split())
        tags = n.get("tags") or []
        suffix = f"  _[tags: {', '.join(str(t) for t in tags)}]_" if tags else ""
        parts.append(f"<!-- id:{nid} --> **{sp}:** {text}{suffix}")
    return "\n".join(parts) + "\n"


def persist_envelope(path: Path, envelope: dict) -> None:
    """Persist the SERIALIZED ENVELOPE (the same notes/cards shape redis carries) as the durable render
    source — NOT the prose markdown ``render_meeting_transcript`` produces.

    This is the deterministic dual-source seam: live folds the redis stream, finished reads THIS file,
    and one renderer renders both identically. The serialization is DETERMINISTIC (``indent=2``,
    ``sort_keys=True``) so the persisted file is byte-stable and == the folded live stream."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(envelope, indent=2, sort_keys=True))


def _seed_dir() -> Path:
    """The mounted seed template dir (the envelope SSOT schema lives under ``agents/``). Resolves the
    selected template out of the registry root (env override wins)."""
    from shared.seeding import resolve_seed_dir

    return resolve_seed_dir()


def load_meeting_schema(seed_dir: Path) -> dict | None:
    """Load the envelope SSOT schema at ``{seed_dir}/agents/meeting.schema.json``. Tolerant: a missing
    (or unreadable / malformed) file → None, so behavior is unchanged when the schema is absent."""
    path = Path(seed_dir) / "agents" / "meeting.schema.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def validate_envelope(envelope: dict, seed_dir: Path) -> list[str]:
    """Validate ``envelope`` against the SSOT schema; return a list of error messages (empty == valid).
    Tolerant: a missing schema → ``[]`` (nothing to validate against, so behavior is unchanged)."""
    schema = load_meeting_schema(seed_dir)
    if schema is None:
        return []
    import jsonschema

    validator = jsonschema.Draft202012Validator(schema)
    return [e.message for e in sorted(validator.iter_errors(envelope), key=lambda e: list(e.path))]


def upsert_meeting_transcript_file(path: Path, meta: dict, note: dict) -> None:
    """Idempotently UPSERT one cleaned ``note`` (keyed by ``note['id']``) into the per-meeting transcript
    file at ``path``. Reads the current id-keyed lines, replaces the matching id (or appends a new one),
    preserves order, and rewrites the whole file. Re-running with the same note id never duplicates a
    line; a refining note for an existing id overwrites its text."""
    nid = str(note.get("id") or "").strip()
    if not nid:
        return
    notes: list[dict] = []
    if path.exists():
        try:
            for line in path.read_text().splitlines():
                m = _PROC_LINE_RE.match(line)
                if not m:
                    continue
                rest = line[m.end():].strip()
                # parse "**Speaker:** text"
                sp = "Speaker"
                body = rest
                if rest.startswith("**") and ":**" in rest:
                    sp = rest[2:rest.index(":**")].strip() or "Speaker"
                    body = rest[rest.index(":**") + 3:].strip()
                notes.append({"id": m.group("id"), "speaker": sp, "text": body})
        except OSError:
            notes = []
    replaced = False
    for existing in notes:
        if existing.get("id") == nid:
            existing["speaker"] = note.get("speaker") or existing.get("speaker")
            existing["text"] = note.get("text") or existing.get("text")
            replaced = True
            break
    if not replaced:
        notes.append({"id": nid, "speaker": note.get("speaker") or "Speaker", "text": note.get("text") or ""})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_meeting_transcript(meta, notes))


def _set_cursor(stream: _Stream, cursor_key: str | None, raw_id: str) -> None:
    """Freeze the per-meeting processed CURSOR = the last raw transcript stream-id cleaned. Best-effort:
    a fake stream without ``set`` (or a transient redis error) must never break the live beat."""
    if not cursor_key:
        return
    setter = getattr(stream, "set", None)
    if setter is None:
        return
    try:
        setter(cursor_key, str(raw_id))
    except Exception:  # noqa: BLE001 — the cursor is an optimization; never crash the meeting loop
        pass


def _proc_note(segment: dict) -> dict | None:
    """The baseline 1:1 cleaned note for ONE segment — id == segment_id, the speaker, and the cleaned
    text (same first-person cleanup the fallback uses). None when there's nothing to emit (empty text)."""
    notes = fallback_processed_notes([segment])
    return notes[0] if notes else None


def serve_meeting(
    stream: _Stream, *, transcript_stream: str, out_topic: str,
    card_turn: Callable[[list[dict]], Iterator[dict]], idle_ms: int,
    beat_segments: int = 4,
    doc_turn: Callable[[list[dict]], Iterator[dict]] | None = None,
    enabled: bool = True,
    start_id: str = "0",
    proc_stream: str | None = None,
    cursor_key: str | None = None,
    on_proc_note: Callable[[dict], None] | None = None,
    on_envelope: Callable[[dict], None] | None = None,
    proc_params: dict | None = None,
) -> None:
    """Consume the meeting's ``transcript.v1`` Stream (the meetings⊥agent seam — read by schema), gate
    cheaply (a NEW speaker, or ``beat_segments`` segments), and run a copilot beat that XADDs proactive
    cards to ``out_topic``. Live drafts (``completed:false``) are included and upserted by ``segment_id``
    — a refining draft updates its line in place rather than piling up a duplicate. The transcript keeps
    it non-idle; ``session_end`` (or an idle gap) reaps it.

    Cards surfaced across the meeting are accumulated (de-duped by title) and, when the meeting reaps,
    handed to ``doc_turn`` — the post-meeting WRITE turn that authors/updates the kg meeting entity.
    BOTH reap paths run the end-sequence (``_finish``), because the idle path is the backstop for every
    meeting whose ``session_end`` never arrives and a backstop that skipped the report would drop it
    silently. The two reaps differ in ONE thing, and it is not the report: a ``session_end`` is
    COMPLETION and carries the ``view_end`` marker; an idle-timeout exit is NOT completion — no marker.
    """
    seen_speakers: set[str] = set()
    buffer: list[dict] = []
    processing_window: list[dict] = []
    window_by_id: dict[str, dict] = {}  # segment_id → its window item, so a refining draft upserts
    cards: list[dict] = []          # running, de-duped (by title) list of every surfaced card
    seen_titles: set[str] = set()
    notes: list[dict] = []          # running 1:1 cleaned notes (by id), the envelope render source
    notes_by_id: dict[str, dict] = {}
    last = start_id
    n = 0
    doc_written = False  # the end-sequence is once-only, whichever reap path runs it

    def _persist_envelope() -> None:
        """DURABLE RENDER SOURCE (deterministic dual-source): persist the SAME running notes/cards the
        worker already tracks as the envelope, alongside (not replacing) the markdown. Best-effort —
        the render-source mirror is an optimization and must never crash the live loop."""
        if on_envelope is None:
            return
        try:
            on_envelope({"notes": notes, "cards": cards})
        except Exception:  # noqa: BLE001 — render-source mirror is an optimization; never crash the loop
            log.warning("serve_meeting: on_envelope persist failed", exc_info=True)

    mirror_dirty: dict[str, dict] = {}  # note id → latest merged note, awaiting a mirror flush

    def _emit_proc_note(note: dict) -> None:
        """XADD ONE cleaned note (id == segment_id) onto the per-meeting processed STREAM — the ONE
        live carrier of cleaned notes (processed-notes.v1; the SSE tails it, the db-writer persists
        it) — and accumulate it into the running envelope + the mirror batch. The workspace-file and
        envelope mirrors are DERIVED views flushed per beat / at session_end (ADR 0027) — writing
        them per note was an O(n²) rewrite in the hot loop."""
        if not note:
            return
        if proc_stream:
            fields = {"note": json.dumps(note)}
            if proc_params:
                # The processing metadata APPLIED (provider/model/pipeline) rides every entry so the
                # durable consumer (meeting-api db-writer → meeting.data processed views) records
                # reproducible provenance for the view it persists.
                fields["params"] = json.dumps(proc_params)
            stream.xadd(proc_stream, fields)
        # Accumulate the SAME 1:1 cleaned note (keyed by id) into the running envelope notes — a refining
        # pass UPDATES its line in place rather than duplicating, exactly like the markdown upsert.
        nid = str(note.get("id") or "").strip()
        if nid:
            existing = notes_by_id.get(nid)
            if existing is None:
                notes_by_id[nid] = note
                notes.append(note)
            else:
                existing.update(note)
            mirror_dirty[nid] = notes_by_id[nid]

    def _flush_mirror() -> None:
        """Flush the DERIVED views (per beat + session_end): upsert each dirty note into the
        per-meeting workspace file (Auth-B/#3a — a chat agent can Read the meeting mid-flight) and
        re-persist the envelope render source. Best-effort — mirrors never crash the live loop."""
        if on_proc_note is not None:
            for note in mirror_dirty.values():
                try:
                    on_proc_note(note)
                except Exception:  # noqa: BLE001 — the workspace mirror is an optimization
                    log.warning("serve_meeting: on_proc_note upsert failed", exc_info=True)
        if mirror_dirty:
            _persist_envelope()
        mirror_dirty.clear()

    def _run_beat(segs: list[dict], idx: int) -> None:
        tid = f"beat{idx}"
        staged = [{**seg, "rewrite_pass": int(seg.get("_rewrite_passes", 0)) + 1} for seg in segs]
        for ev in card_turn(staged):
            if ev.get("type") == "card":
                _accumulate_card(cards, seen_titles, ev.get("card") or {})
            elif ev.get("type") == "note":
                # The LLM rewrite returned a valid note for this id → UPGRADE the cleaned-stream text
                # (baseline already emitted at ingest; this is the richer pass, still 1:1 by segment_id).
                # Notes ride ONLY processed-notes.v1 — the out-stream is cards + agent activity, per
                # its name (ADR 0027 carrier collapse; the SSE tails the proc stream directly).
                _emit_proc_note(ev.get("note") or {})
                continue
            stream.xadd(out_topic, {"event": json.dumps({**ev, "turn_id": tid})})
        stream.xadd(out_topic, {"event": json.dumps({"type": "turn-complete", "turn_id": tid})})
        sent_ids = {id(seg) for seg in segs}
        for seg in processing_window:
            if id(seg) in sent_ids:
                seg["_rewrite_passes"] = int(seg.get("_rewrite_passes", 0)) + 1
        _flush_mirror()

    def _finish(*, complete: bool) -> None:
        """The END-SEQUENCE, run exactly once per meeting on EITHER reap path — an explicit
        ``session_end`` or an idle transcript. Either way this worker is done: it returns straight
        after and the container is reaped, so the final beat, the mirrors and the post-meeting doc
        turn belong here, on the one path every meeting takes. ``doc_written`` makes it idempotent:
        whichever reap arrives first owns the report, and a second call is a no-op.

        ``complete`` is the ONE thing the two reaps do not share. A ``session_end`` is COMPLETION —
        the meeting is over, no further note can exist, so the ``view_end`` marker is emitted and the
        processed view is final. An idle-timeout exit is NOT completion — no marker: the transcript
        merely went quiet, and the watcher re-arms a worker for this same row on its next batch, which
        resumes from the frozen cursor and appends MORE notes to THIS stream. processed-notes.v1 says
        the stream is COMPLETE at the marker, so emitting one here would lie to every consumer that
        reads it (the db-writer stops re-draining, the live SSE closes, the admin panel reports a
        clean drain). What covers a markerless stream is the consumers' own bounded deadline — P22's
        hard guarantee, designed for exactly the worker that ends without a marker."""
        nonlocal n, doc_written
        if doc_written:
            return
        doc_written = True
        mutable = [seg for seg in processing_window if int(seg.get("_rewrite_passes", 0)) < 3]
        if mutable and enabled:
            n += 1
            _run_beat(mutable, n)
        _flush_mirror()      # ingest-only notes (no beat ran) reach the mirrors too
        _persist_envelope()  # final durable render source (notes + accumulated cards)
        # processed-notes.v1 ``view_end`` (ADR 0027): the stream is COMPLETE at this entry — the final
        # beat has run and every note is emitted. The db-writer flushes the durable view ON this
        # marker; the live SSE closes on it. Emitted BEFORE the doc turn (30s+ of LLM the durable
        # flush must not wait on) and regardless of ``enabled`` (baseline notes flow even with live
        # beats off — the emit gate is proc_stream, same as _emit_proc_note's).
        if complete and proc_stream:
            end_marker: dict = {"type": "view_end"}
            if last and last != "0":
                end_marker["cursor"] = str(last)
            stream.xadd(proc_stream, end_marker)
        if doc_turn is not None and notes:  # author/update only when transcript evidence exists
            _emit_turn(stream, out_topic, lambda: doc_turn(cards), "meeting-doc")

    while True:
        resp = stream.xread({transcript_stream: last}, count=50, block=idle_ms)
        if not resp:
            # The transcript went quiet, not COMPLETE: the report is authored (this is the backstop
            # for every meeting whose session_end never arrives), the view is left unmarked.
            _finish(complete=False)
            return
        new_speaker = False
        for _name, entries in resp:
            for entry_id, fields in entries:
                last = entry_id
                payload = json.loads(fields.get("payload", "{}"))
                if payload.get("type") == "session_end":
                    _finish(complete=True)
                    return  # meeting ended → reap
                for seg_index, seg in enumerate(payload.get("segments", [])):
                    sid = seg.get("segment_id") or f"{entry_id}:{seg_index}"
                    existing = window_by_id.get(sid)
                    if existing is not None:
                        # A live draft refining (or finalizing) a segment already in the window: update
                        # it IN PLACE so the next beat reads the latest text, never a duplicate line.
                        # Identity is preserved, so the rewrite-pass bookkeeping still holds.
                        existing["text"] = seg.get("text", existing.get("text"))
                        existing["completed"] = seg.get("completed", True)
                        continue
                    item = dict(seg)
                    item["segment_id"] = sid
                    item["_rewrite_passes"] = 0
                    window_by_id[sid] = item
                    buffer.append(item)
                    processing_window.append(item)
                    # Baseline 1:1 cleaned note onto the processed stream — ALWAYS present per segment,
                    # so the cleaned channel never has a gap even before/without an LLM upgrade beat.
                    base = _proc_note(item)
                    if base is not None:
                        _emit_proc_note(base)
                    sp = seg.get("speaker")
                    if sp and sp not in seen_speakers:
                        seen_speakers.add(sp)
                        new_speaker = True
                # Advance the per-meeting CURSOR to the last raw stream-id we've now cleaned (gap-fill
                # picks up from here on re-enable; OFF freezes it at the last processed entry).
                _set_cursor(stream, cursor_key, entry_id)
        if enabled and buffer and (new_speaker or len(buffer) >= beat_segments):
            n += 1
            mutable = [seg for seg in processing_window if int(seg.get("_rewrite_passes", 0)) < 3]
            if mutable:
                _run_beat(mutable, n)
            processing_window = [seg for seg in processing_window if int(seg.get("_rewrite_passes", 0)) < 3]
            window_by_id = {seg["segment_id"]: seg for seg in processing_window}
            buffer = []


def _accumulate_card(cards: list[dict], seen_titles: set[str], card: dict) -> None:
    """Retain a surfaced card, de-duped by (case-folded) title so re-surfacing across beats doesn't
    duplicate it in the final meeting doc."""
    title = (card.get("title") or "").strip()
    if not title:
        return
    key = title.casefold()
    if key in seen_titles:
        return
    seen_titles.add(key)
    cards.append(card)


def _emit_turn(stream: _Stream, out_topic: str, turn: Callable[[], Iterator[dict]], tid: str) -> None:
    for ev in turn():
        stream.xadd(out_topic, {"event": json.dumps({**ev, "turn_id": tid})})
    stream.xadd(out_topic, {"event": json.dumps({"type": "turn-complete", "turn_id": tid})})


def _emit_beat(stream: _Stream, out_topic: str, card_turn, segments: list[dict], n: int) -> None:
    _emit_turn(stream, out_topic, lambda: card_turn(segments), f"beat{n}")


# ── post-meeting WRITE turn: distill the surfaced cards into the kg meeting entity ────────────────

_CARD_GROUP = {  # card kind → the section it lands under in the doc
    "person": "Attendees", "company": "Companies", "product": "Products",
}

MEETING_DOC_PROMPT = (
    "The meeting has ENDED. Author or update the knowledge-graph entity for it as a SINGLE markdown "
    "file at the EXACT path `kg/entities/meeting/{native}.md` in this workspace (create parent dirs if "
    "needed). This must be IDEMPOTENT — if the file already exists, UPDATE it in place (do not create a "
    "duplicate or a new path).\n\n"
    "The file MUST have this exact YAML frontmatter (between `---` fences) as the very first lines:\n"
    "---\n"
    "type: meeting\n"
    "id: {native}\n"
    "title: {title}\n"
    "meeting_id: {meeting_id}\n"
    "session_uid: {session_uid}\n"
    "platform: {platform}\n"
    "date: {date}\n"
    "---\n\n"
    "After the frontmatter, write a 2-4 line plain-English SUMMARY of the meeting (no transcript — a "
    "distilled summary), then the surfaced entities grouped under `## Attendees`, `## Companies`, "
    "`## Topics`, `## Decisions`, `## Actions` headings, each entry a `[[wikilink]]` (omit a heading if "
    "it has no entries). Here are the entities surfaced during the meeting (JSON):\n\n{cards}\n\n"
    "Do NOT copy the raw transcript. When done, write/edit ONLY that one file."
)


# The Turkish report. The instruction frame stays ENGLISH — it is a file-writing contract (an exact path,
# a preserved frontmatter, three literal headings) and the small instruct model this deployment runs obeys
# that frame best in English — while the OUTPUT language is STATED, not implied. The three `##` headings
# are a CONTRACT with the terminal (`clients/terminal/src/canvas/AutomaticMeetingRecap.tsx` matches
# `^## Özet`, `^## Alınan Kararlar`, `^## Aksiyon Maddeleri`): change a character here and the recap panel
# stops recognizing the report.
TURKISH_MEETING_DOC_PROMPT = (
    "The meeting has ENDED. Author or update the knowledge-graph entity at the EXACT path "
    "`kg/entities/meeting/{native}.md`. Read the existing file first and use its speaker-attributed "
    "transcript as the only evidence for the report. You must preserve the exact YAML frontmatter. Replace "
    "only the Markdown body, and write every narrative sentence in Turkish. This operation must be "
    "idempotent: update the existing path and do not create a duplicate or a new path.\n\n"
    "Use exactly these three second-level headings, in this order, copied character for character — "
    "they are a contract with the reader's UI, so never translate, reword or re-order them:\n"
    "## Özet\n\n"
    "## Alınan Kararlar\n\n"
    "## Aksiyon Maddeleri\n\n"
    "Write a concise summary grounded only in the transcript. Include a decision only when the "
    "transcript explicitly records agreement, approval, rejection, or another commitment. If no "
    "decision was recorded, state that briefly in Turkish. For each action, preserve the explicit "
    "participant owner and deadline when present. Write `Sorumlu belirtilmedi` when no owner is "
    "assigned; do not infer an owner or deadline from topic, role, speaking order, or the surfaced "
    "cards. If no action was recorded, state that briefly in Turkish.\n\n"
    "The surfaced cards below may supplement entity links, but they are not evidence for decisions, "
    "actions, owners, or deadlines (JSON):\n\n{cards}\n\n"
    "Write EVERY sentence of the body in Turkish — the summary, each decision and each action. Only the "
    "YAML frontmatter, the three headings above, and participant/product names are copied verbatim; no "
    "English prose appears anywhere in the file.\n"
    "Write or edit ONLY `kg/entities/meeting/{native}.md`."
)


def build_meeting_doc_prompt(
    cards: list[dict], *, native: str, meeting_id: str, session_uid: str,
    platform: str, date: str, title: str, report_language: str = "en",
) -> str:
    """Compose the post-meeting doc prompt. ``report_language`` is the ONE selector between the Turkish
    and the English report; it is workspace-governed (``agents/meeting.md`` frontmatter → ``MeetingConfig
    .report_language``, threaded through ``meeting_doc_turn``), so a workspace switches languages by
    editing a visible file, no redeploy."""
    template = TURKISH_MEETING_DOC_PROMPT if report_language.strip().lower() == "tr" else MEETING_DOC_PROMPT
    return template.format(
        native=native, title=title, meeting_id=meeting_id, session_uid=session_uid,
        platform=platform, date=date, cards=json.dumps(cards, ensure_ascii=False),
    )


# The REPORT'S STRUCTURAL CONTRACT, per output language — what a written report must contain for the
# turn to count as having produced one. ``report_language`` picks the prompt, so it picks the shape
# that prompt MANDATES: `tr`'s three `##` headings are the same three the terminal's recap panel
# regex-matches (`clients/terminal/src/canvas/AutomaticMeetingRecap.tsx`), so a file missing one is a
# file the reader never sees. A language whose prompt mandates no fixed heading (`en`, whose entity
# sections are omitted when empty) declares none and is held to the universal floor in
# ``report_defect``. Adding a language here is how its UI contract becomes machine-checked.
REPORT_HEADINGS: dict[str, tuple[str, ...]] = {
    "tr": ("## Özet", "## Alınan Kararlar", "## Aksiyon Maddeleri"),
}

_FRONTMATTER_BLOCK_RE = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n?", re.DOTALL)


def report_defect(target: Path, report_language: str = "en") -> str:
    """What is MISSING from the post-meeting report at ``target`` — ``""`` when the file IS the report.

    The floor is language-independent and holds for every language: the file exists, its body past the
    frontmatter is not empty, and that body is not the id-keyed transcript this module's own mirror
    writes (``render_meeting_transcript``) — which is exactly what the path holds when the write turn
    answered in prose and never called Write. On top of the floor, a language that declares headings in
    ``REPORT_HEADINGS`` must carry all of them, matched the way its consumer matches them (a whole
    line, trailing whitespace allowed)."""
    try:
        text = target.read_text()
    except OSError:
        return f"no report file at {target.name}"
    body = _FRONTMATTER_BLOCK_RE.sub("", text).strip()
    if not body:
        return f"{target.name} has no report body"
    if any(_PROC_LINE_RE.match(line) for line in body.splitlines()):
        return f"{target.name} still holds the raw transcript"
    lines = [line.rstrip() for line in body.splitlines()]
    missing = [h for h in REPORT_HEADINGS.get(report_language.strip().lower(), ()) if h not in lines]
    if missing:
        return f"{target.name} is missing the mandated heading(s) {', '.join(missing)}"
    return ""


# The post-meeting report is a ONE-SHOT: the worker reaps right after it, so a lost turn is a lost
# report. Two attempts with a short backoff cover the failures that pass on their own (a 429 burst, a
# gateway blip, a read timeout, a turn that came back without the artifact) and nothing else — an
# unretryable failure must surface at once.
_DOC_TURN_ATTEMPTS = 2
_DOC_TURN_BACKOFF_S = 0.5

# Transient classification reads the LANGUAGE-INDEPENDENT layer of a failure first: HTTP status codes,
# provider error-type codes and transport errno names are protocol literals no translation touches.
# It has to, because the text a consumer reads is written in the product's UI language — llm/
# claude_code.py rewrites an auth ``reply`` into Turkish (parking the raw provider text in ``detail``),
# and llm/errors.py's generic fallback is Turkish too.
_TRANSIENT_CODE_RE = re.compile(
    r"\b(?:429|500|502|503|504|529)\b"
    r"|\b(?:overloaded|rate[ _-]?limit|api|timeout|service[ _-]?unavailable)_error\b"
    r"|\b(?:econnreset|econnrefused|econnaborted|etimedout|epipe)\b",
    re.IGNORECASE,
)

# The prose layer, for providers that emit only prose — read in BOTH of the deployment's languages.
# It errs toward retrying: a false "transient" costs one bounded extra call, a false "permanent" costs
# the meeting its report.
_TRANSIENT_PROSE_RE = re.compile(
    r"rate[ _-]*limit"
    r"|too many requests"
    r"|overloaded"
    r"|timed?[ _-]*out|timeout"
    r"|temporar\w*"
    r"|unavailable"
    r"|bad gateway"
    r"|internal server error"
    r"|connection (?:reset|refused|aborted|error)"
    r"|broken pipe"
    r"|hız sınırı|istek sınırı|çok fazla istek"
    r"|aşırı yüklen\w*|aşırı yük"
    r"|zaman aşımı"
    r"|geçici\w*"
    r"|kullanılamıyor|kullanılamadı|hizmet dışı"
    r"|sunucu hatası"
    r"|bağlantı (?:sıfırlandı|reddedildi|kesildi|hatası)",
    re.IGNORECASE,
)


def _done_failure_text(event: dict) -> str:
    """Everything a failed harness ``done`` event says about WHY. ``detail`` is load-bearing: the
    claude-code adapter replaces an auth ``reply`` with the platform remediation line in the product's
    UI language and parks the raw provider text — the one carrying the 401 signature — in ``detail``."""
    return " ".join(str(event.get(key) or "") for key in ("reply", "detail", "error"))


def _failure_kind(detail: object) -> str:
    """Classify a doc-turn failure as ``auth``, ``transient`` or ``permanent``. Only ``transient`` is
    retried. Auth wins on a tie: a 401 body that also says "unavailable" is still a rejected credential,
    and retrying it just doubles the operator's wait for the same error."""
    text = str(detail or "")
    if looks_like_auth_failure(text):
        return "auth"
    if _TRANSIENT_CODE_RE.search(text) or _TRANSIENT_PROSE_RE.search(text):
        return "transient"
    return "permanent"


# The user-visible line for a turn that finished without writing the report. It is rendered VERBATIM
# in the terminal, so it is written in the product's UI language; the machine-readable reason and what
# the model said instead ride in ``detail``.
_NO_REPORT_REPLY = (
    "Toplantı raporu oluşturulamadı: model turu tamamlandı ancak rapor dosyası yazılmadı."
)


def _no_report_event(event: dict, defect: str) -> dict:
    """The harness ``done`` of a turn that completed WITHOUT the artifact, re-stated as the failure it
    is — so a consumer keying on ``done.ok`` sees the report's verdict, not the turn's."""
    said = " ".join(str(event.get("reply") or "").split())[:200]
    return {
        **event,
        "ok": False,
        "reply": _NO_REPORT_REPLY,
        "detail": f"{defect}{f' — model reply: {said}' if said else ''}",
    }


def meeting_doc_turn(
    work: Path, cards: list[dict], *, native: str, meeting_id: str, session_uid: str,
    platform: str, date: str, title: str, model: str | None = None, report_language: str = "en",
) -> Iterator[dict]:
    """The post-meeting WRITE turn: ONE governed turn (commit=True, Write/Edit allowed,
    session_continuity=False so it never touches the chat session) that authors/updates the meeting
    entity at ``kg/entities/meeting/<native>.md`` — a distilled summary + the surfaced cards as grouped
    wikilinks. Idempotent (re-running updates rather than duplicates).

    SUCCESS IS THE ARTIFACT. The harness's ``done.ok`` says the TURN completed, not that the REPORT was
    written: a model that answers in prose and never calls Write completes happily and leaves the path
    holding the raw transcript. Every attempt is judged by ``report_defect`` — the file on disk against
    the shape this ``report_language``'s prompt mandates — and a turn that produced no report is a
    failure whatever the flag said.

    This turn is the meeting's LAST chance at its report: the worker returns straight after, the
    container is reaped, and nothing re-dispatches it. So a TRANSIENT failure (a 429, a gateway 5xx, a
    timeout, a turn that came back without the artifact) is retried once, after a short backoff, from
    the pre-turn file. An AUTH failure never is — the credential will not fix itself in two seconds,
    and a retry only doubles the operator's wait. On the last attempt the failure SURFACES: the
    pre-turn file is restored and the turn's one terminal event carries ``ok: false`` and the reason."""
    prompt = build_meeting_doc_prompt(
        cards, native=native, title=title, meeting_id=meeting_id, session_uid=session_uid,
        platform=platform, date=date, report_language=report_language,
    )
    target = work / "kg" / "entities" / "meeting" / f"{native}.md"
    previous = target.read_bytes() if target.exists() else None
    succeeded = False

    def restore_target() -> None:
        if previous is None:
            target.unlink(missing_ok=True)
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(previous)

    try:
        for attempt in range(1, _DOC_TURN_ATTEMPTS + 1):
            final_attempt = attempt == _DOC_TURN_ATTEMPTS
            retry = False
            events = run_turn_over_workspace(
                work, prompt, model=model, allowed_tools=["Read", "Write", "Edit"],
                commit=True, session_continuity=False,
            )
            try:
                for event in events:
                    if event.get("type") != "done":
                        yield event
                        continue
                    # The turn's verdict is the FILE, not the flag: a completed turn that produced no
                    # report is a failure, and a retryable one — the artifact is what we came for.
                    defect = report_defect(target, report_language) if event.get("ok", True) is True else ""
                    succeeded = event.get("ok", True) is True and not defect
                    if succeeded:
                        yield event
                        continue
                    restore_target()
                    kind = "transient" if defect else _failure_kind(_done_failure_text(event))
                    if not final_attempt and kind == "transient":
                        # The re-attempt owns the outcome, so this attempt's terminal event is
                        # NOT forwarded: a consumer keys on ONE `done` per turn.
                        retry = True
                        break
                    yield _no_report_event(event, defect) if defect else event
            except LLMAuthError:
                raise  # a rejected credential is not transient — surface it now
            except Exception as exc:  # noqa: BLE001 — classified below; anything unretryable re-raises
                # The class name carries the signal a bare transport exception's message often doesn't
                # (``ReadTimeout()`` stringifies empty).
                if final_attempt or _failure_kind(f"{type(exc).__name__}: {exc}") != "transient":
                    raise
                retry = True
            if not retry:
                return
            events.close()  # abandon the failed attempt's turn — the re-attempt owns the outcome
            log.warning(
                "meeting_doc_turn: transient failure on attempt %d/%d — retrying the post-meeting report",
                attempt, _DOC_TURN_ATTEMPTS,
            )
            time.sleep(_DOC_TURN_BACKOFF_S)
            restore_target()  # the re-attempt reads the PRE-TURN file, never a half-written one
    finally:
        if not succeeded:
            restore_target()
