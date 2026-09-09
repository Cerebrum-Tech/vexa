"""Uploads eval — an audio/video file becomes a meeting, on the bot's own wire.

Everything here drives SHIPPED code (``uploads.build_router`` mounted on the real
``create_app``; ``uploads.run_upload_job``) through in-memory ports. The load-bearing assertion is
not that the job produces segments — it is that the frames it produces are the SAME frames the bot
produces, proved by feeding them through the collector's REAL ``ingest`` and reading the transcript
back out of the store. That is what makes "nothing downstream is taught about uploads" a fact
rather than a claim.

ffmpeg is injected (``decode=``) like every other collaborator, so the whole suite runs with no
native binary; one extra test exercises the real decoder when ffmpeg IS on the machine.
"""
from __future__ import annotations

import io
import json
import math
import os
import shutil
import struct
import tempfile
from array import array

import fakeredis.aioredis
import pytest
from fastapi.testclient import TestClient

from meeting_api import create_app
from meeting_api.collector import ingest
from meeting_api.collector.fakes import FakeRedisBus, InMemoryTranscriptStore
from meeting_api.uploads import media, run_upload_job, to_segments
from meeting_api.uploads.fakes import (
    InMemoryJobQueue,
    InMemoryMediaStore,
    InMemoryUploadStore,
    RecordingBus,
    ScriptedTranscriber,
)
from meeting_api.uploads.service import SEGMENT_STREAM


# ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
@pytest.fixture
def media_store(tmp_path):
    return InMemoryMediaStore(str(tmp_path / "objects"))


@pytest.fixture
def store():
    return InMemoryUploadStore()


def fake_decoder(seconds: float):
    """A ``decode`` double: writes ``seconds`` of silent 16 kHz mono PCM and reports its size.

    Silence is fine — the transcriber is scripted, so the audio's CONTENT is never read. What the
    job needs from the decoder is a real file of a known length, because every window offset and
    every progress percentage is arithmetic over that length.
    """
    async def _decode(src_path, dst_path, *, ffmpeg="ffmpeg"):
        n = int(seconds * media.BYTES_PER_SECOND)
        n -= n % media.SAMPLE_WIDTH
        with open(dst_path, "wb") as fh:
            fh.write(b"\x00" * n)
        return n
    return _decode


def job_for(row: dict, *, key: str = "uploads/7/up-1/source.mp4", language: str = "tr") -> dict:
    return {"meeting_id": row["id"], "user_id": row["user_id"],
            "native_meeting_id": row["native_meeting_id"], "object_key": key,
            "language": language, "speaker": "Konuşmacı"}


async def seed(store, media_store, *, user_id: int = 7, key: str = "uploads/7/up-1/source.mp4"):
    """A queued upload whose source object really exists in the media store."""
    src = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    src.write(b"not really media - the decoder is injected")
    src.close()
    await media_store.upload_file(key, src.name, content_type="video/mp4")
    os.unlink(src.name)
    return await store.create_upload_meeting(
        user_id, native_meeting_id="up-1", title="Haftalık toplantı",
        upload={"id": "up-1", "filename": "toplanti.mp4", "object_key": key, "state": "queued",
                "language": "tr", "speaker": "Konuşmacı", "segments": 0,
                "transcribed_seconds": 0.0},
    )


# ── the pure mapper ──────────────────────────────────────────────────────────────────────────────
def test_to_segments_places_a_window_on_the_recordings_timeline():
    from datetime import datetime, timezone

    start = datetime(2026, 9, 8, 10, 0, 0, tzinfo=timezone.utc)
    out = to_segments(
        [{"start": 1.5, "end": 3.0, "text": " merhaba "}, {"start": 3.0, "end": 4.25, "text": "dünya"}],
        offset_s=600.0, native="up-1", speaker="Konuşmacı", speaker_key="upload-1",
        language="tr", session_start=start,
    )
    assert [s["start"] for s in out] == [601.5, 603.0]
    assert [s["end"] for s in out] == [603.0, 604.25]
    assert out[0]["text"] == "merhaba"                       # whitespace trimmed
    assert out[0]["segment_id"] == "up-1:upload-1:601500"    # the contract's stable id form
    assert out[0]["speaker"] == "Konuşmacı" and out[0]["completed"] is True
    assert out[0]["absolute_start_time"] == "2026-09-08T10:10:01.500000Z"


def test_to_segments_drops_rows_the_collector_would_silently_discard():
    from datetime import datetime, timezone

    out = to_segments(
        [
            {"start": 0.0, "end": 1.0, "text": "   "},        # no text
            {"start": 2.0, "end": 2.0, "text": "zero length"},  # end == start
            {"start": 4.0, "end": 3.0, "text": "inverted"},     # end < start
            {"start": 5.0, "text": "no end"},                   # malformed
            {"start": 6.0, "end": 7.0, "text": "keep"},
        ],
        offset_s=0.0, native="up-1", speaker="S", speaker_key="upload-1", language=None,
        session_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    assert [s["text"] for s in out] == ["keep"]


# ── the job ──────────────────────────────────────────────────────────────────────────────────────
async def test_job_emits_segments_then_session_end_and_completes_the_row(store, media_store):
    row = await seed(store, media_store)
    bus = RecordingBus()
    tx = ScriptedTranscriber([[{"start": 0.0, "end": 2.0, "text": "birinci pencere"}],
                             [{"start": 0.0, "end": 2.0, "text": "ikinci pencere"}]])
    finalized = []

    async def _finalize(meeting_id):
        finalized.append(meeting_id)
        return 0

    result = await run_upload_job(
        job_for(row), store=store, media_store=media_store, transcriber=tx, bus=bus,
        window_s=6.0, decode=fake_decoder(12.0),
        transcript_finalizer=_finalize,
    )

    assert result["status"] == "completed"
    assert result["duration_seconds"] == 12.0
    # every frame rode the ONE wire the bot writes
    assert {stream for stream, _ in bus.frames} == {SEGMENT_STREAM}
    # …and session_end is LAST, so the collector has drained every segment before the copilot reaps
    assert bus.types()[-1] == "session_end"
    assert bus.types().count("session_end") == 1
    assert all(t == "transcription" for t in bus.types()[:-1])
    assert len(tx.calls) == 2, "12 s at a 6 s window is two windows"
    segs = bus.segments()
    assert [s["text"] for s in segs] == ["birinci pencere", "ikinci pencere"]
    assert segs[1]["start"] > segs[0]["start"]   # the second window is offset onto the timeline
    row_after = await store.get_upload(7, row["id"])
    assert row_after["status"] == "completed"
    assert row_after["upload"]["state"] == "done"
    assert row_after["upload"]["duration_seconds"] == 12.0
    assert row_after["upload"]["transcribed_seconds"] == 12.0
    assert row_after["upload"]["segments"] == 2
    assert finalized == [row["id"]]              # durable immediately, like a bot's meeting
    # the source recording existed to make the job restartable; the job is over, so it is gone
    assert media_store.deleted == ["uploads/7/up-1/source.mp4"]
    assert row_after["upload"]["source_deleted"] is True
    assert row_after["upload"]["object_key"] is None   # the row stops advertising a dead object


async def test_job_carries_the_previous_windows_tail_as_context(store, media_store):
    row = await seed(store, media_store)
    tx = ScriptedTranscriber([[{"start": 0.0, "end": 2.0, "text": "önceki cümlenin sonu"}],
                             [{"start": 0.0, "end": 2.0, "text": "devamı"}]])
    # The tail is carried only on the serial lane (concurrency=1): parallel windows have no
    # "previous" result to hand on, and the service drops the prompt there deliberately.
    await run_upload_job(job_for(row), store=store, media_store=media_store, transcriber=tx,
                         bus=RecordingBus(), window_s=6.0, decode=fake_decoder(12.0), concurrency=1)
    assert tx.calls[0]["prompt"] is None                       # nothing precedes the first window
    assert tx.calls[1]["prompt"] == "önceki cümlenin sonu"     # continuity across the cut
    assert all(c["language"] == "tr" for c in tx.calls)


async def test_job_reports_the_users_failure_and_still_closes_the_session(store, media_store):
    row = await seed(store, media_store)
    bus = RecordingBus()
    tx = ScriptedTranscriber(fail_with="the transcription service stayed unavailable")

    result = await run_upload_job(job_for(row), store=store, media_store=media_store,
                                 transcriber=tx, bus=bus, window_s=6.0, decode=fake_decoder(12.0))

    assert result["status"] == "failed"
    row_after = await store.get_upload(7, row["id"])
    assert row_after["status"] == "failed"
    assert "unavailable" in row_after["upload"]["error"]
    # a FAILED job KEEPS its source: re-running it is the remedy, and deleting the user's recording
    # is the one thing that makes the failure unrecoverable.
    assert media_store.deleted == []
    # session_end is emitted on the failure path too — a copilot armed by the first frames must not
    # sit blocked until its idle timeout because the job died.
    assert bus.types() == ["session_end"]
    assert [ch for ch, _ in bus.published][-1] == "u:7:meetings"


async def test_keep_source_leaves_the_recording_in_place(store, media_store):
    """An operator who wants the originals kept flips one knob and the blob survives."""
    row = await seed(store, media_store)
    await run_upload_job(job_for(row), store=store, media_store=media_store,
                         transcriber=ScriptedTranscriber([[{"start": 0.0, "end": 2.0, "text": "x"}]]),
                         bus=RecordingBus(), window_s=6.0, keep_source=True,
                         decode=fake_decoder(12.0))
    assert media_store.deleted == []
    row_after = await store.get_upload(7, row["id"])
    assert row_after["upload"]["source_deleted"] is False
    assert row_after["upload"]["object_key"] == "uploads/7/up-1/source.mp4"


async def test_a_decode_failure_is_the_users_error_not_a_crash(store, media_store):
    row = await seed(store, media_store)

    async def _boom(src, dst, *, ffmpeg="ffmpeg"):
        raise media.DecodeFailed("Invalid data found when processing input")

    result = await run_upload_job(job_for(row), store=store, media_store=media_store,
                                 transcriber=ScriptedTranscriber(), bus=RecordingBus(),
                                 window_s=6.0, decode=_boom)
    assert result["status"] == "failed"
    assert "Invalid data" in (await store.get_upload(7, row["id"]))["upload"]["error"]


async def test_a_job_that_keeps_being_reclaimed_is_failed_not_retried_forever(store, media_store):
    row = await seed(store, media_store)
    await store.advance_upload(row["id"], upload={"attempts": 3})
    tx = ScriptedTranscriber([[{"start": 0.0, "end": 1.0, "text": "asla"}]])

    result = await run_upload_job(job_for(row), store=store, media_store=media_store,
                                 transcriber=tx, bus=RecordingBus(), window_s=6.0,
                                 max_attempts=3, decode=fake_decoder(12.0))

    assert result["status"] == "failed"
    assert tx.calls == []                     # it never reached the transcription service
    assert "gave up after 3 attempts" in (await store.get_upload(7, row["id"]))["upload"]["error"]


# ── the load-bearing claim: these frames ARE the bot's frames ────────────────────────────────────
async def test_the_emitted_frames_flow_through_the_real_collector(store, media_store):
    """The uploads job's output, fed to the collector's REAL ``ingest``, produces a readable
    transcript and the ``tc:meeting:{row}`` session_end marker — with no upload-aware code path
    anywhere between. This is the claim the whole design rests on."""
    row = await seed(store, media_store)
    collector_store = InMemoryTranscriptStore()
    collector_store.seed_meeting(user_id=7, platform="upload", native_meeting_id="up-1",
                                 meeting_id=row["id"])
    bus = RecordingBus()
    tx = ScriptedTranscriber([[{"start": 0.0, "end": 2.0, "text": "toplantıya hoş geldiniz"}],
                              [{"start": 0.5, "end": 2.0, "text": "ikinci pencere"}]])
    await run_upload_job(job_for(row), store=store, media_store=media_store, transcriber=tx,
                         bus=bus, window_s=6.0, decode=fake_decoder(12.0))

    client = fakeredis.aioredis.FakeRedis()
    collector_bus = FakeRedisBus(client)
    try:
        for _stream, payload in bus.frames:
            await ingest(collector_store, collector_bus, {"payload": json.dumps(payload)})

        doc = await collector_store.get_transcript(7, "upload", "up-1")
        assert [s["text"] for s in doc["segments"]] == ["toplantıya hoş geldiniz", "ikinci pencere"]
        assert [s["speaker"] for s in doc["segments"]] == ["Konuşmacı", "Konuşmacı"]
        # the collector wrote the copilot's reap marker onto the row-keyed carrier IT owns (P23) —
        # nothing in the uploads module touched tc:meeting:{row}
        entries = await client.xrange(f"tc:meeting:{row['id']}")
        payloads = [json.loads(f[b"payload"] if b"payload" in f else f["payload"])
                    for _id, f in entries]
        assert payloads[-1]["type"] == "session_end"
        assert [p["type"] for p in payloads[:-1]] == ["transcription", "transcription"]
        # and the live channel the gateway /ws fans out carried the segments too
        assert any(ch == f"tc:meeting:{row['id']}:mutable" for ch, _raw in collector_bus.published)
    finally:
        await client.aclose()


# ── the routes ───────────────────────────────────────────────────────────────────────────────────
@pytest.fixture
def app_client(store, media_store):
    queue = InMemoryJobQueue()
    app = create_app(upload_store=store, upload_media_store=media_store, upload_queue=queue)
    with TestClient(app) as client:
        yield client, queue


def _post(client, *, filename="toplanti.mp4", data=b"x" * 2048, user="7", **form):
    return client.post(
        "/uploads",
        files={"file": (filename, io.BytesIO(data), "video/mp4")},
        data=form or None,
        headers={"X-User-Id": user} if user else {},
    )


def test_post_uploads_lands_the_bytes_mints_the_row_and_queues_the_job(app_client, store, media_store):
    client, queue = app_client
    resp = _post(client, title="Haftalık toplantı", language="tr")
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["platform"] == "upload" and body["status"] == "requested"
    assert body["native_meeting_id"].startswith("up-")
    assert body["title"] == "Haftalık toplantı"
    assert body["upload"]["language"] == "tr"
    assert body["upload"]["speaker"] == "Konuşmacı"        # whisper does not diarize: one label
    assert body["upload"]["bytes"] == 2048
    # the source object is durable BEFORE the 202 — that is what makes the job restartable
    assert os.path.exists(media_store._path(body["upload"]["object_key"]))
    assert len(queue.jobs) == 1
    assert queue.jobs[0][1]["meeting_id"] == body["id"]


def test_post_uploads_refuses_a_file_that_is_definitely_not_a_recording(app_client):
    client, _ = app_client
    for name in ("rapor.pdf", "notlar.docx", "arsiv.zip", "ekran.png", "kurulum.exe"):
        resp = _post(client, filename=name)
        assert resp.status_code == 415, name
        assert name[name.rindex("."):] in resp.json()["detail"]


def test_post_uploads_accepts_an_unfamiliar_or_missing_extension(app_client):
    """A filename is not evidence about content — ffmpeg is, and it decides in the job.

    A device that writes an extension this list has not heard of (or none at all) must not be
    refused at the door: that would make the extension list, rather than the decoder, the definition
    of which recordings the product accepts."""
    client, queue = app_client
    for name in ("kayit.m4b", "sesli-not.awb", "toplanti.mxf", "recording"):
        resp = _post(client, filename=name)
        assert resp.status_code == 202, f"{name} -> {resp.status_code}: {resp.text}"
    assert len(queue.jobs) == 4


def test_the_formats_people_actually_upload_are_accepted(app_client):
    client, _ = app_client
    for name in ("toplanti.mp3", "toplanti.mp4", "sesli-not.m4a", "kayit.wav",
                 "ekran-kaydi.mkv", "zoom.m4a", "teams.webm", "telefon.amr", "ses.opus"):
        assert _post(client, filename=name).status_code == 202, name


def test_post_uploads_enforces_the_size_ceiling_while_spooling(store, media_store):
    queue = InMemoryJobQueue()
    app = create_app(upload_store=store, upload_media_store=media_store, upload_queue=queue,
                     upload_max_bytes=1024)
    with TestClient(app) as client:
        resp = _post(client, data=b"x" * 4096)
    assert resp.status_code == 413
    assert queue.jobs == []          # nothing queued, and no row minted for work we refused
    assert store.rows == {}


def test_post_uploads_refuses_without_a_transcription_backend(app_client, monkeypatch):
    client, queue = app_client
    monkeypatch.delenv("TRANSCRIPTION_SERVICE_URL", raising=False)
    resp = _post(client)
    assert resp.status_code == 503
    assert "TRANSCRIPTION_SERVICE_URL" in resp.json()["detail"]
    assert queue.jobs == []


def test_uploads_are_owner_scoped(app_client):
    client, _ = app_client
    created = _post(client, user="7").json()
    assert client.get(f"/uploads/{created['id']}", headers={"X-User-Id": "7"}).status_code == 200
    assert client.get(f"/uploads/{created['id']}", headers={"X-User-Id": "8"}).status_code == 404
    assert client.get(f"/uploads/{created['id']}").status_code == 401
    assert _post(client, user=None).status_code == 401


def test_get_upload_serves_the_progress_the_row_carries(app_client, store):
    client, _ = app_client
    created = _post(client).json()
    body = client.get(f"/uploads/{created['id']}", headers={"X-User-Id": "7"}).json()
    assert body["upload"]["state"] == "queued"
    assert body["upload"]["transcribed_seconds"] == 0.0


# ── the media unit ───────────────────────────────────────────────────────────────────────────────
def _tone(seconds: float, *, quiet_at: tuple = ()) -> bytes:
    n = int(seconds * media.SAMPLE_RATE)
    buf = array("h", [0] * n)
    for i in range(n):
        t = i / media.SAMPLE_RATE
        amp = 200 if any(abs(t - g) < 0.4 for g in quiet_at) else 12000
        buf[i] = int(amp * math.sin(2 * math.pi * 220 * t))
    return buf.tobytes()


def test_windows_tile_the_recording_exactly():
    pcm = _tone(25.0, quiet_at=(5, 10, 15, 20))
    windows = list(media.iter_windows(pcm, window_s=5.0, search_s=1.0, probe_s=0.25))
    assert sum(len(w) for _s, w in windows) == len(pcm)     # no gaps, no overlap
    offset = 0
    for start_s, w in windows:
        assert start_s == pytest.approx(offset / media.BYTES_PER_SECOND)
        offset += len(w)


def test_windows_cut_in_the_silence_not_on_the_nominal_boundary():
    pcm = _tone(25.0, quiet_at=(5, 10, 15, 20))
    windows = list(media.iter_windows(pcm, window_s=5.0, search_s=1.0, probe_s=0.25))
    boundaries, offset = [], 0
    for _s, w in windows[:-1]:
        offset += len(w)
        boundaries.append(offset / media.BYTES_PER_SECOND)
    # every boundary lands inside a quiet stretch (5 ± 0.4 s, …), not at the nominal 5/10/15 s
    for b, gap in zip(boundaries, (5, 10, 15, 20)):
        assert gap - 0.45 <= b <= gap + 0.45
        assert b != gap


def test_the_file_iterator_is_the_bytes_iterator(tmp_path):
    """The production path reads windows off disk so a six-hour recording costs the same memory as
    a six-minute one; it must produce the byte-identical tiling."""
    pcm = _tone(25.0, quiet_at=(5, 10, 15, 20))
    path = tmp_path / "audio.pcm"
    path.write_bytes(pcm)
    a = [(s, len(w)) for s, w in media.iter_windows(pcm, window_s=5.0, search_s=1.0, probe_s=0.25)]
    b = [(s, len(w)) for s, w in media.iter_windows_file(str(path), len(pcm), window_s=5.0,
                                                         search_s=1.0, probe_s=0.25)]
    assert a == b


def test_wav_header_is_what_the_stt_service_decodes():
    pcm = _tone(1.0)
    wav = media.wav_of(pcm)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    channels, rate = struct.unpack("<HI", wav[22:28])
    assert (channels, rate) == (1, media.SAMPLE_RATE)
    assert struct.unpack("<I", wav[40:44])[0] == len(pcm)
    assert len(wav) == 44 + len(pcm)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on this machine")
async def test_the_real_decoder_turns_a_container_into_pcm(tmp_path):
    """The one test that needs the native binary the image installs: a real WAV in, 16 kHz mono
    s16le PCM out, at the length the arithmetic downstream assumes."""
    src, dst = tmp_path / "in.wav", tmp_path / "out.pcm"
    src.write_bytes(media.wav_of(_tone(2.0)))
    size = await media.decode_to_pcm(str(src), str(dst))
    assert size == dst.stat().st_size
    assert media.duration_seconds(size) == pytest.approx(2.0, abs=0.05)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on this machine")
async def test_a_file_that_is_not_media_is_refused_by_the_decoder(tmp_path):
    src, dst = tmp_path / "in.mp4", tmp_path / "out.pcm"
    src.write_bytes(b"this is not a container")
    with pytest.raises(media.DecodeFailed):
        await media.decode_to_pcm(str(src), str(dst))
