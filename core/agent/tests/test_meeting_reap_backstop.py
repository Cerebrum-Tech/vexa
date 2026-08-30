"""test_meeting_reap_backstop.py — the two guarantees the post-meeting report hangs on, offline.

1. THE REAP IS A BACKSTOP. A meeting ends for the worker either on a ``session_end`` marker or on an
   idle transcript, and the idle path is the one that catches every meeting whose marker never
   arrives. Both run the end-sequence — final beat, mirrors, doc turn — exactly once, and neither
   invents a report for a meeting with no transcript evidence. Only ``session_end`` adds the
   ``view_end`` marker: a quiet transcript is not a finished meeting.

2. THE DOC TURN IS A ONE-SHOT. The worker returns straight after it and the container is reaped, so
   a transient provider failure is retried once from the pre-turn file, while a rejected credential
   is surfaced immediately (a retry cannot fix it).

No redis, no docker, no provider: a fake stream and a ``ClaudeCodeHarness`` over a canned ``exec_fn``.
"""
from __future__ import annotations

import json
import unittest.mock as mock

from llm.claude_code import ClaudeCodeHarness
from worker import meeting as meeting_module
from worker import worker
from worker.worker import serve_meeting


class ReapStream:
    """A fake stream that serves ``inbox`` in one read and then goes idle, recording every XADD."""

    def __init__(self, inbox=None):
        self.out: list[tuple[str, dict]] = []
        self._inbox = list(inbox or [])
        self.reads = 0

    def xadd(self, name, fields):
        self.out.append((name, fields))
        return str(len(self.out))

    def xread(self, streams, count=1, block=None):
        self.reads += 1
        tname = next(iter(streams))
        if not self._inbox:
            return []
        batch, self._inbox = self._inbox, []
        return [(tname, list(batch))]

    def markers(self, proc_stream):
        return [f for name, f in self.out if name == proc_stream and f.get("type") == "view_end"]

    def events(self):
        return [json.loads(f["event"]) for _n, f in self.out if "event" in f]


class LateSessionEndStream(ReapStream):
    """Idle FIRST (the reap that writes the report), and only then a ``session_end`` — the late marker
    that must never author a second report."""

    def __init__(self, inbox, late_entry):
        super().__init__(inbox)
        self._late = late_entry
        self._idled = False

    def xread(self, streams, count=1, block=None):
        self.reads += 1
        tname = next(iter(streams))
        if self._inbox:
            batch, self._inbox = self._inbox, []
            return [(tname, list(batch))]
        if not self._idled:
            self._idled = True
            return []  # the idle reap
        return [(tname, [self._late])]


def _seg(speaker, text):
    return {"speaker": speaker, "text": text, "completed": True}


def _transcript(eid, *segs):
    return (eid, {"payload": json.dumps({"type": "transcription", "segments": list(segs)})})


def _session_end(eid="9-0"):
    return (eid, {"payload": json.dumps({"type": "session_end"})})


def _card_turn(segments):
    yield {"type": "card", "card": {"kind": "person", "title": "Ayşe", "body": "yeni katılımcı"}}


def _doc_turn_recorder(calls):
    def doc_turn(cards):
        calls.append(list(cards))
        yield {"type": "done", "ok": True, "reply": "kg/entities/meeting/m1.md yazıldı"}
    return doc_turn


# ── (i) the idle reap writes the report ───────────────────────────────────────────────────────────

def test_idle_reap_runs_the_doc_turn_without_claiming_completion():
    """No ``session_end`` ever arrives — the transcript just goes quiet. The idle reap still runs the
    post-meeting doc turn with the meeting's de-duped cards (before this, the idle return dropped the
    report silently) and still emits every note — but it does NOT claim the view is complete: the
    ``view_end`` marker belongs to ``session_end`` alone."""
    calls: list[list[dict]] = []
    s = ReapStream(inbox=[_transcript("1-0", {**_seg("Ayşe", "merhaba"), "segment_id": "a"})])

    serve_meeting(
        s, transcript_stream="tc:m1", out_topic="o", card_turn=_card_turn, idle_ms=10,
        doc_turn=_doc_turn_recorder(calls), proc_stream="proc:meeting:m1",
    )

    assert len(calls) == 1                                   # the report was authored on the idle path
    assert [c["title"] for c in calls[0]] == ["Ayşe"]        # with the surfaced cards
    assert s.markers("proc:meeting:m1") == []                # …and NOT a completion claim
    assert any(e.get("turn_id") == "meeting-doc" and e.get("type") == "done" for e in s.events())
    assert any(name == "proc:meeting:m1" and "note" in f for name, f in s.out)  # notes still flowed


def test_idle_reap_writes_no_report_without_transcript_evidence():
    """A meeting that produced no transcript produces no report — the doc turn's gate is EVIDENCE
    (running notes), not the reap. A model asked to summarize nothing would hallucinate one."""
    calls: list[list[dict]] = []
    s = ReapStream(inbox=[])  # the bot joined, nothing was ever said

    serve_meeting(
        s, transcript_stream="tc:m1", out_topic="o", card_turn=_card_turn, idle_ms=10,
        doc_turn=_doc_turn_recorder(calls), proc_stream="proc:meeting:m1",
    )

    assert calls == []
    assert [f for name, f in s.out if name == "o"] == []  # no beat, no turn events


# ── (ii) the end-sequence is once-only ────────────────────────────────────────────────────────────

def test_late_session_end_after_an_idle_report_does_not_write_twice():
    """The idle reap owns the report; a ``session_end`` that lands afterwards must not author a second
    one (a duplicated doc turn burns a second LLM call and re-commits the same entity)."""
    calls: list[list[dict]] = []
    s = LateSessionEndStream(
        inbox=[_transcript("1-0", {**_seg("Ayşe", "merhaba"), "segment_id": "a"})],
        late_entry=_session_end("2-0"),
    )

    serve_meeting(
        s, transcript_stream="tc:m1", out_topic="o", card_turn=_card_turn, idle_ms=10,
        doc_turn=_doc_turn_recorder(calls), proc_stream="proc:meeting:m1",
    )

    assert len(calls) == 1                                   # exactly one report
    assert s.markers("proc:meeting:m1") == []                # the idle owner claimed no completion
    doc_events = [e for e in s.events() if e.get("turn_id") == "meeting-doc" and e.get("type") == "done"]
    assert len(doc_events) == 1


def test_session_end_reap_still_runs_the_end_sequence_once():
    """The marker path is unchanged by the backstop: one report, one view_end — and the marker lands
    BEFORE the doc turn's 30s+ of LLM, so the durable flush never waits on it."""
    calls: list[list[dict]] = []
    s = ReapStream(inbox=[
        _transcript("1-0", {**_seg("Ayşe", "merhaba"), "segment_id": "a"}),
        _session_end("2-0"),
    ])

    serve_meeting(
        s, transcript_stream="tc:m1", out_topic="o", card_turn=_card_turn, idle_ms=10,
        doc_turn=_doc_turn_recorder(calls), proc_stream="proc:meeting:m1",
    )

    assert len(calls) == 1
    markers = s.markers("proc:meeting:m1")
    assert len(markers) == 1 and markers[0]["cursor"] == "2-0"
    marker_at = max(i for i, (name, f) in enumerate(s.out)
                    if name == "proc:meeting:m1" and f.get("type") == "view_end")
    doc_at = min(i for i, (_n, f) in enumerate(s.out)
                 if "event" in f and json.loads(f["event"]).get("turn_id") == "meeting-doc")
    assert marker_at < doc_at


# ── (iii) the doc turn's bounded retry ────────────────────────────────────────────────────────────

def _result(text, *, ok=True):
    return json.dumps({
        "type": "result", "subtype": "success" if ok else "error", "is_error": not ok,
        "result": text, "session_id": "s1",
    })


REPORT = (
    "---\ntype: meeting\nid: m1\nplatform: teams\n---\n\n"
    "## Özet\nEkip yerel kurulumu değerlendirdi.\n\n"
    "## Alınan Kararlar\n- Gemma kullanılmasına karar verildi.\n\n"
    "## Aksiyon Maddeleri\n- Model indirilecek. Sorumlu: Mehmet\n"
)

TRANSCRIPT = (
    "---\ntype: meeting\nid: m1\nplatform: teams\n---\n\n"
    "## Transcript\n\n<!-- id:1 --> **Ayşe:** Gemma kullanmaya karar verdik.\n"
)


def _run_doc_turn(tmp_path, exec_fn, monkeypatch):
    monkeypatch.setattr(meeting_module, "_DOC_TURN_BACKOFF_S", 0)
    with mock.patch.object(worker, "harness_factory", lambda: ClaudeCodeHarness(exec_fn=exec_fn)):
        return list(worker.meeting_doc_turn(
            tmp_path, [], native="m1", meeting_id="m1", session_uid="session-1",
            platform="teams", date="2026-08-25", title="Toplantı", report_language="tr",
        ))


def test_doc_turn_retries_a_transient_failure_from_the_pre_turn_file(tmp_path, monkeypatch):
    """A 429 on the first attempt is retried once — and the re-attempt reads the PRE-TURN file, not the
    half-written one the failed attempt left behind."""
    doc = tmp_path / "kg" / "entities" / "meeting" / "m1.md"
    doc.parent.mkdir(parents=True)
    doc.write_text(TRANSCRIPT)
    seen: list[str] = []

    def exec_fn(argv, cwd):
        seen.append(doc.read_text())          # what THIS attempt starts from
        if len(seen) == 1:
            doc.write_text("yarım kalmış çıktı")   # a half-written file, then the provider 429s
            yield _result("429 Too Many Requests from the model gateway", ok=False)
            return
        doc.write_text(REPORT)
        yield _result("kg/entities/meeting/m1.md yazıldı")

    events = _run_doc_turn(tmp_path, exec_fn, monkeypatch)

    assert len(seen) == 2 and seen[1] == TRANSCRIPT       # attempt 2 restarted from the pre-turn file
    dones = [e for e in events if e.get("type") == "done"]
    assert len(dones) == 1 and dones[0]["ok"] is True     # ONE terminal event: the retry's outcome
    assert doc.read_text() == REPORT


def test_doc_turn_gives_up_after_two_transient_failures(tmp_path, monkeypatch):
    """The retry is BOUNDED: two attempts, then the failure surfaces and the file is restored."""
    doc = tmp_path / "kg" / "entities" / "meeting" / "m1.md"
    doc.parent.mkdir(parents=True)
    doc.write_text(TRANSCRIPT)
    attempts: list[int] = []

    def exec_fn(argv, cwd):
        attempts.append(1)
        doc.write_text("yarım kalmış çıktı")
        yield _result("503 Service Unavailable", ok=False)

    events = _run_doc_turn(tmp_path, exec_fn, monkeypatch)

    assert len(attempts) == 2
    assert [e["ok"] for e in events if e.get("type") == "done"] == [False]
    assert doc.read_text() == TRANSCRIPT


def test_doc_turn_never_retries_an_auth_failure(tmp_path, monkeypatch):
    """A rejected credential is not transient — one attempt, then the failure surfaces. The adapter
    rewrites the auth ``reply`` into the platform remediation line and parks the raw 401 in ``detail``,
    so the classifier reads BOTH: judging the reply alone would read an auth failure as unknown."""
    doc = tmp_path / "kg" / "entities" / "meeting" / "m1.md"
    doc.parent.mkdir(parents=True)
    doc.write_text(TRANSCRIPT)
    attempts: list[int] = []

    def exec_fn(argv, cwd):
        attempts.append(1)
        doc.write_text("yarım kalmış çıktı")
        yield _result("Not logged in · Please run /login", ok=False)

    events = _run_doc_turn(tmp_path, exec_fn, monkeypatch)

    (done,) = [e for e in events if e.get("type") == "done"]
    assert len(attempts) == 1                      # NOT retried
    assert done["ok"] is False and "401" not in done["reply"]
    assert doc.read_text() == TRANSCRIPT           # the half-written file was restored


def test_doc_turn_never_retries_a_permanent_failure(tmp_path, monkeypatch):
    """Only the transient classes are retried; a plain model refusal is surfaced on the first attempt."""
    attempts: list[int] = []

    def exec_fn(argv, cwd):
        attempts.append(1)
        yield _result("the requested tool is not allowed in this turn", ok=False)

    events = _run_doc_turn(tmp_path, exec_fn, monkeypatch)

    assert len(attempts) == 1
    assert [e["ok"] for e in events if e.get("type") == "done"] == [False]


# ── (iv) success is the ARTIFACT, not the harness's turn-completion flag ───────────────────────────

def _write_doc(tmp_path, text=TRANSCRIPT):
    doc = tmp_path / "kg" / "entities" / "meeting" / "m1.md"
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_text(text)
    return doc


def test_a_turn_that_answers_in_prose_and_never_writes_is_a_failure(tmp_path, monkeypatch):
    """The harness `done.ok` says the TURN finished, not that the REPORT exists. A model that replies
    in prose and never calls Write finishes happily — and used to be recorded as SUCCESS, leaving the
    report path holding the raw transcript with no retry and no error anywhere."""
    doc = _write_doc(tmp_path)
    attempts: list[str] = []

    def exec_fn(argv, cwd):
        attempts.append(doc.read_text())
        yield _result("Toplantıyı özetledim: ekip yerel kurulumu değerlendirdi.")  # prose, no write

    events = _run_doc_turn(tmp_path, exec_fn, monkeypatch)

    assert len(attempts) == 2                              # judged a retryable failure, tried twice
    (done,) = [e for e in events if e.get("type") == "done"]
    assert done["ok"] is False                             # NOT the ok=True the harness reported
    assert "still holds the raw transcript" in done["detail"]
    assert doc.read_text() == TRANSCRIPT                   # restored, so the transcript is not lost


def test_a_prose_only_first_attempt_is_retried_and_the_retry_authors_the_report(tmp_path, monkeypatch):
    """A turn that came back without the artifact is TRANSIENT: it is retried from the pre-turn file
    inside the existing budget, and a re-attempt that writes owns the outcome — one `done`, ok=True."""
    doc = _write_doc(tmp_path)
    attempts: list[str] = []

    def exec_fn(argv, cwd):
        attempts.append(doc.read_text())
        if len(attempts) == 1:
            yield _result("Rapor hazır.")                  # claims success, writes nothing
            return
        doc.write_text(REPORT)
        yield _result("kg/entities/meeting/m1.md yazıldı")

    events = _run_doc_turn(tmp_path, exec_fn, monkeypatch)

    assert attempts == [TRANSCRIPT, TRANSCRIPT]            # attempt 2 read the PRE-TURN file
    dones = [e for e in events if e.get("type") == "done"]
    assert len(dones) == 1 and dones[0]["ok"] is True
    assert doc.read_text() == REPORT


def test_a_report_missing_a_mandated_heading_is_not_a_report(tmp_path, monkeypatch):
    """The three `##` headings are the contract the terminal's recap panel matches on: a file missing
    one is a file the reader never sees, so the turn has not produced the report."""
    doc = _write_doc(tmp_path)

    def exec_fn(argv, cwd):
        doc.write_text(
            "---\ntype: meeting\nid: m1\n---\n\n## Özet\nEkip yerel kurulumu değerlendirdi.\n"
        )
        yield _result("yazıldı")

    events = _run_doc_turn(tmp_path, exec_fn, monkeypatch)

    (done,) = [e for e in events if e.get("type") == "done"]
    assert done["ok"] is False
    assert "## Alınan Kararlar" in done["detail"] and "## Aksiyon Maddeleri" in done["detail"]
    assert doc.read_text() == TRANSCRIPT


ENGLISH_REPORT = (
    "---\ntype: meeting\nid: m1\n---\n\n"
    "Priya joined and committed to sending a quote.\n\n## Attendees\n- [[Priya]]\n"
)


def test_report_defect_is_language_aware(tmp_path):
    """The verification reads the shape the SELECTED language's prompt mandates — the Turkish headings
    are never asserted against an English report. The floor below them holds for every language: a
    missing file, an empty body, or a body that is still the id-keyed transcript mirror."""
    doc = tmp_path / "kg" / "entities" / "meeting" / "m1.md"
    defect = meeting_module.report_defect

    assert defect(doc, "tr") == "no report file at m1.md"          # nothing was ever written
    doc.parent.mkdir(parents=True)

    doc.write_text(ENGLISH_REPORT)
    assert defect(doc, "en") == ""                                  # the English report is a report
    assert "## Özet" in defect(doc, "tr")                           # …and is not the Turkish one

    doc.write_text(REPORT)
    assert defect(doc, "tr") == "" and defect(doc, "en") == ""      # a Turkish report satisfies both

    doc.write_text(TRANSCRIPT)                                      # the mirror, not the report
    for language in ("tr", "en"):
        assert defect(doc, language) == "m1.md still holds the raw transcript"

    doc.write_text("---\ntype: meeting\nid: m1\n---\n\n   \n")      # frontmatter, no body
    for language in ("tr", "en"):
        assert defect(doc, language) == "m1.md has no report body"


# ── (v) the failure classifier reads BOTH of the deployment's languages ────────────────────────────

def test_failure_kind_classifies_across_languages():
    """The failure text a consumer reads is written in the product's UI language (llm/claude_code.py
    Turkifies an auth `reply`; llm/errors.py's generic fallback is Turkish), so the classifier keys on
    the language-independent layer — HTTP codes, provider error-type codes, errno names — and reads
    the prose layer in both languages. An auth signature still wins over a transient one."""
    kind = meeting_module._failure_kind

    assert kind("HTTP 503 from the model gateway") == "transient"
    assert kind("rate_limit_error") == "transient"
    assert kind("ECONNRESET") == "transient"
    assert kind("Model sağlayıcısı geçici olarak kullanılamıyor") == "transient"
    assert kind("Sağlayıcı zaman aşımına uğradı") == "transient"
    assert kind("Çok fazla istek gönderildi") == "transient"
    assert kind("Sunucu aşırı yüklendi") == "transient"
    assert kind("Not logged in · Please run /login") == "auth"
    assert kind("401 Unauthorized — servis kullanılamıyor") == "auth"   # auth wins the tie
    assert kind("istenen araca bu turda izin verilmiyor") == "permanent"


def test_doc_turn_retries_a_transient_failure_reported_in_turkish(tmp_path, monkeypatch):
    """End to end: a provider failure surfaced in Turkish prose alone — no status code to read — is
    still retried, so a Turkish deployment does not lose the report the English one keeps."""
    doc = _write_doc(tmp_path)
    attempts: list[int] = []

    def exec_fn(argv, cwd):
        attempts.append(1)
        if len(attempts) == 1:
            yield _result("Model sağlayıcısı şu anda kullanılamıyor, lütfen tekrar deneyin", ok=False)
            return
        doc.write_text(REPORT)
        yield _result("kg/entities/meeting/m1.md yazıldı")

    events = _run_doc_turn(tmp_path, exec_fn, monkeypatch)

    assert len(attempts) == 2
    dones = [e for e in events if e.get("type") == "done"]
    assert len(dones) == 1 and dones[0]["ok"] is True
    assert doc.read_text() == REPORT


# ── (vi) an idle reap is not completion — the marker would be a lie ────────────────────────────────

def test_a_resumed_worker_appends_notes_after_an_idle_reap():
    """WHY the idle path emits no marker: the transcript going quiet does not end the meeting. The
    watcher re-arms a worker for this same row on its next batch, it resumes from the frozen cursor,
    and MORE notes land on the SAME proc stream — after the point an idle marker would have declared
    the view COMPLETE. The one marker belongs to the reap that really ended the meeting."""
    first = ReapStream(inbox=[_transcript("1-0", {**_seg("Ayşe", "merhaba"), "segment_id": "a"})])
    serve_meeting(
        first, transcript_stream="tc:m1", out_topic="o", card_turn=_card_turn, idle_ms=10,
        proc_stream="proc:meeting:m1",
    )
    assert first.markers("proc:meeting:m1") == []

    resumed = ReapStream(inbox=[
        _transcript("2-0", {**_seg("Mehmet", "modeli indireceğim"), "segment_id": "b"}),
        _session_end("3-0"),
    ])
    serve_meeting(
        resumed, transcript_stream="tc:m1", out_topic="o", card_turn=_card_turn, idle_ms=10,
        start_id="1-0", proc_stream="proc:meeting:m1",
    )
    entries = [f for name, f in first.out + resumed.out if name == "proc:meeting:m1"]
    assert [json.loads(f["note"])["id"] for f in entries if "note" in f] == ["a", "b"]
    assert [f for f in entries if f.get("type") == "view_end"] == [{"type": "view_end", "cursor": "3-0"}]
    assert entries[-1].get("type") == "view_end"   # the completion claim is the stream's LAST entry
