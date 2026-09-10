"""The upload job — a recording becomes a meeting.

``run_upload_job`` is the whole feature in one explicitly-driven function: fetch the source media,
decode it once, walk it window by window through the STT service, and XADD each window's segments
onto ``transcription_segments`` — the SAME wire the bot writes. That choice is the design:

  * the collector persists the segments and owns ``tc:meeting:{row}`` as its single writer (P23);
  * the agent watcher arms the meeting's copilot off the very same frames;
  * the terminating ``session_end`` frame rides the SAME stream, so it is ordered BEHIND every
    segment it follows — the copilot's post-meeting report can never be authored against a
    half-drained transcript, and no wait/sleep is needed to make that true.

So an uploaded recording produces exactly what an attended meeting produces — transcript, live
list entry, Turkish post-meeting report — and nothing downstream knows the difference.

No background loop lives here: like the collector's ``consume_segments`` and the runtime
scheduler's ``tick()``, this is one call the entrypoint's loop drives and the tests drive
identically. Same in ⇒ same out.
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from . import media
from .ports import Bus, MediaStore, Transcriber, TranscriberUnavailable, UploadStore

#: The stream every transcript producer writes. Named here rather than imported from the collector
#: so the brick keeps its own front door (``gate:exports``); the two constants are the one wire.
SEGMENT_STREAM = "transcription_segments"

#: ``platform`` for a meeting that has no platform: nobody joined anything. The value is carried
#: verbatim through the list, the transcript and the copilot's meeting doc.
PLATFORM = "upload"

#: How many segments ride one XADD. The collector coerces per segment, so batching is purely about
#: not minting one stream entry per utterance on a two-hour recording.
SEGMENTS_PER_FRAME = 25

#: How much of the previous window's tail is handed to the next window as whisper's ``prompt``.
#: Context continuity across a cut, exactly as the live pipeline does it.
PROMPT_TAIL_CHARS = 400


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _noop_log(*_args, **_kwargs) -> dict:
    return {}


#: Whisper's known Turkish hallucinations — the subtitle credit and YouTube-outro boilerplate it
#: emits on silence. The bot filters the same phrases through the gmeet-pipeline phrase lists
#: (``hallucinations/tr.txt``, the canonical list); an uploaded recording never passes through that
#: pipeline, so its producer holds the verified floor too. Matched case-insensitively after trim,
#: trailing punctuation stripped.
HALLUCINATIONS: frozenset[str] = frozenset(t.casefold() for t in (
    "Altyazı M.K.", "Altyazı M.K", "Altyazı M. K.", "Altyazı MK", "Altyazı: M.K.", "Alt yazı M.K.",
    "Altyazı M.K. tarafından", "Altyazı çevirmeni M.K.",
    "Abone olmayı unutmayın", "Abone olmayı unutmayınız", "Beni takip etmeyi unutmayın",
    "İzlediğiniz için teşekkür ederim", "İzlediğiniz için teşekkürler",
    "Bir sonraki videoda görüşmek üzere", "Kanalıma abone olmayı unutmayın",
))


def is_hallucination(text: str) -> bool:
    """True when ``text`` is one of whisper's known silence phrases, not something a person said."""
    t = text.strip().casefold()
    if t in HALLUCINATIONS:
        return True
    stripped = t.rstrip(".!?… ")
    return stripped in HALLUCINATIONS or (stripped + ".") in HALLUCINATIONS


def to_segments(
    raw: list, *, offset_s: float, native: str, speaker: str, speaker_key: str,
    language: Optional[str], session_start: datetime,
) -> list[dict]:
    """One window's ``verbose_json`` rows → transcript.v1 segments on the recording's timeline.

    PURE — the piece worth testing on its own. ``offset_s`` moves the window's own 0-based times
    onto the recording's timeline; ``segment_id`` follows the contract's stable
    ``{session_uid}:{speaker_key}:{startMs}`` form, which is what makes a re-transcribed window
    overwrite its own rows instead of duplicating them.

    Rows whisper emits with no text, with a known hallucination phrase (``HALLUCINATIONS``), or
    with an end at or before their start, are DROPPED here
    rather than downstream: the collector would silently discard them (``ingest._coerce_segment``),
    and a segment count that counts rows nobody stores is a lie on the progress bar.
    """
    out: list[dict] = []
    for row in raw or []:
        if not isinstance(row, dict):
            continue
        text = (row.get("text") or "").strip()
        if not text or is_hallucination(text):
            continue
        try:
            start = float(row["start"]) + offset_s
            end = float(row["end"]) + offset_s
        except (KeyError, TypeError, ValueError):
            continue
        if end <= start:
            continue
        out.append({
            "segment_id": f"{native}:{speaker_key}:{int(round(start * 1000))}",
            "speaker": speaker,
            "speaker_key": speaker_key,
            "text": text,
            "start": round(start, 3),
            "end": round(end, 3),
            "language": row.get("language") or language,
            "completed": True,
            "absolute_start_time": _iso(session_start + timedelta(seconds=start)),
            "absolute_end_time": _iso(session_start + timedelta(seconds=end)),
        })
    return out


async def _emit(bus: Bus, *, meeting_id: int, native: str, segments: list[dict]) -> None:
    for i in range(0, len(segments), SEGMENTS_PER_FRAME):
        await bus.xadd(SEGMENT_STREAM, {
            "type": "transcription",
            "meeting_id": meeting_id,
            "native_meeting_id": native,
            "platform": PLATFORM,
            "segments": segments[i:i + SEGMENTS_PER_FRAME],
        })


async def _end_session(bus: Bus, *, meeting_id: int, native: str) -> None:
    """Close the session on the SAME stream the segments rode.

    Ordered behind them by construction, so the collector has drained every segment into
    ``tc:meeting:{row}`` before it writes the marker there — and the copilot reaps (and writes its
    report) against a COMPLETE transcript. Emitted on the failure path too: a job that dies must
    not leave a copilot container blocked until its 4-hour idle timeout.
    """
    await bus.xadd(SEGMENT_STREAM, {
        "type": "session_end", "meeting_id": meeting_id, "native_meeting_id": native,
        "platform": PLATFORM, "uid": native,
    })


async def _publish_status(bus: Bus, *, user_id: int, meeting_id: int, native: str, status: str,
                          log_event: Callable) -> None:
    """Push the row's new status onto the user's meetings channel so the terminal's list moves
    while the job runs. Best-effort: a fan-out failure is never the job's failure."""
    import json

    frame = {"type": "meeting.status", "meeting_id": meeting_id, "native": native,
             "status": status, "when": _iso(_now())}
    try:
        await bus.publish(f"u:{user_id}:meetings", json.dumps(frame))
    except Exception as e:  # noqa: BLE001 — the DB row is the record; this is only the live nudge
        log_event("upload_status_publish_failed", audience="system", level="warning",
                  span="uploads.job", fields={"meeting_id": meeting_id, "error": str(e)})


async def run_upload_job(
    job: dict,
    *,
    store: UploadStore,
    media_store: MediaStore,
    transcriber: Transcriber,
    bus: Bus,
    window_s: float = 300.0,
    concurrency: int = 4,
    max_attempts: int = 3,
    keep_source: bool = False,
    workdir: Optional[str] = None,
    ffmpeg: str = "ffmpeg",
    decode: Optional[Callable] = None,
    log_event: Callable = _noop_log,
    transcript_finalizer: Optional[Callable] = None,
) -> dict:
    """Run ONE upload to completion. Returns ``{meeting_id, status, segments, duration_seconds}``.

    ``decode`` is the ffmpeg step, injected like every other collaborator (default
    :func:`media.decode_to_pcm`) so the offline lane proves this function without a native binary.

    The source recording is DELETED from object storage once the transcript exists (``keep_source``
    overrides). It was only ever stored so a job could survive a replica dying mid-transcode; past
    that point it is a gigabyte of duplicate media whose value now lives in the transcript. A FAILED
    job keeps its source — that is precisely the case where re-running it is the remedy.

    Never raises for a job-level fault: a failure is recorded ON THE ROW (status ``failed`` +
    ``data.upload.error``) and reported to the caller, because a job that raises into the loop is
    a job the user is never told about (P18 — the fault is surfaced on an observable channel).
    """
    decode = decode or media.decode_to_pcm
    meeting_id = int(job["meeting_id"])
    user_id = int(job["user_id"])
    native = str(job["native_meeting_id"])
    object_key = str(job["object_key"])
    language = job.get("language") or None
    speaker = job.get("speaker") or "Konuşmacı"
    speaker_key = job.get("speaker_key") or "upload-1"

    # A job that KILLS its replica (an OOM on a pathological file) is reclaimed from the pending
    # list by a peer — forever, unless something counts. The count lives on the ROW, the one place
    # that outlives both the replica and the redis entry, so the third attempt is the last and the
    # user is told why instead of watching a permanent `transcribing`.
    prior = await store.get_upload(user_id, meeting_id)
    attempts = int(((prior or {}).get("upload") or {}).get("attempts") or 0) + 1
    if attempts > max_attempts:
        return await _fail(store, bus, meeting_id=meeting_id, user_id=user_id, native=native,
                           reason=f"transcription gave up after {max_attempts} attempts",
                           segments=0, log_event=log_event)

    session_start = _now()
    await store.advance_upload(
        meeting_id, status="active", start_time=_iso(session_start),
        upload={"state": "transcribing", "started_at": _iso(session_start), "error": None,
                "attempts": attempts},
    )
    await _publish_status(bus, user_id=user_id, meeting_id=meeting_id, native=native,
                          status="active", log_event=log_event)

    tmpdir = tempfile.mkdtemp(prefix="vexa-upload-", dir=workdir)
    src_path = os.path.join(tmpdir, "source")
    pcm_path = os.path.join(tmpdir, "audio.pcm")
    total = 0
    duration = 0.0
    try:
        await media_store.download_file(object_key, src_path)
        pcm_bytes = await decode(src_path, pcm_path, ffmpeg=ffmpeg)
        os.remove(src_path)  # the source is durable in object storage; the copy on disk is not needed
        duration = media.duration_seconds(pcm_bytes)
        await store.advance_upload(meeting_id, upload={"duration_seconds": round(duration, 2)})
        log_event("upload_decoded", audience="system", span="uploads.job",
                  meeting_id=str(meeting_id),
                  fields={"duration_seconds": round(duration, 2), "pcm_bytes": pcm_bytes})

        # WINDOWS IN PARALLEL. A recording is not a live meeting: its windows have no ordering
        # dependency on each other, every segment carries its own absolute offset, and the whole file
        # is on disk before the first request goes out. Transcribing them one at a time made an
        # upload as slow as a conversation — an hour of audio spent an hour's worth of waiting on a
        # GPU that sat idle between calls.
        #
        # The earlier serialization was meant to keep a batch job from crowding out live meetings.
        # That was the right worry and the wrong mechanism: the STT service already reserves realtime
        # slots for live traffic (REALTIME_RESERVED_SLOTS) and answers 503 + Retry-After when its
        # deferred lane is full — which this client already honours as a schedule. Throttling to one
        # in flight was a second, cruder copy of a policy that belongs to the service.
        #
        # `concurrency` bounds only what WE have outstanding, and never more than that many decoded
        # windows are resident, so memory stays flat in the length of the recording.
        done_seconds = 0.0
        in_flight: set = set()

        async def _window(offset: float, pcm: bytes, prior: Optional[str]):
            raw = await transcriber.transcribe(media.wav_of(pcm), language=language, prompt=prior)
            return offset, media.duration_seconds(len(pcm)), raw

        async def _collect(finished) -> Optional[str]:
            """Fold one finished window into the transcript + the progress row.

            Returns that window's trailing text, which serial mode chains into the next window's
            prompt (and parallel mode discards)."""
            nonlocal total, done_seconds
            offset, span, raw = finished.result()
            segments = to_segments(
                raw, offset_s=offset, native=native, speaker=speaker, speaker_key=speaker_key,
                language=language, session_start=session_start,
            )
            if segments:
                # Emitted as each window lands, NOT in window order: every segment carries its own
                # start, and the collector orders the transcript by it. Waiting for order here would
                # re-serialize what we just parallelized.
                await _emit(bus, meeting_id=meeting_id, native=native, segments=segments)
                total += len(segments)
            done_seconds = min(duration, done_seconds + span)
            await store.advance_upload(meeting_id, upload={
                "transcribed_seconds": round(done_seconds, 2), "segments": total,
            })
            return segments[-1]["text"][-PROMPT_TAIL_CHARS:] if segments else None

        async def _drain(finished) -> Optional[str]:
            """Fold EVERY finished window, then re-raise the first failure among them.

            Retrieving all of them matters even when one has failed: a task whose exception is never
            read is reported by asyncio as "Task exception was never retrieved", which buries the
            real reason for the job's failure under a stack trace per sibling."""
            first_error: Optional[BaseException] = None
            tail: Optional[str] = None
            for task in finished:
                try:
                    tail = await _collect(task)
                except BaseException as exc:  # noqa: BLE001 — re-raised below, once, in order
                    if first_error is None:
                        first_error = exc
            if first_error is not None:
                raise first_error
            return tail

        # The previous window's tail as whisper's `prompt` is a SEQUENTIAL device — it cannot survive
        # windows running at once. It is dropped above concurrency 1, deliberately: boundaries are
        # already cut at the quietest point near each split, so the context a prompt carried across
        # them is a small refinement, and an hour of extra waiting is not a small price for it. Set
        # VEXA_UPLOAD_CONCURRENCY=1 to trade the speed back for it.
        lanes = max(1, int(concurrency))
        prompt: Optional[str] = None
        try:
            for start_s, window in media.iter_windows_file(pcm_path, pcm_bytes, window_s=window_s):
                while len(in_flight) >= lanes:
                    finished, in_flight = await asyncio.wait(
                        in_flight, return_when=asyncio.FIRST_COMPLETED)
                    await _drain(finished)
                in_flight.add(asyncio.create_task(
                    _window(start_s, window, prompt if lanes == 1 else None)))
                if lanes == 1:
                    # Serial mode keeps the continuity chain: drain now so the NEXT window is given
                    # this one's tail, which is the only reason to run serially at all.
                    finished, in_flight = await asyncio.wait(
                        in_flight, return_when=asyncio.ALL_COMPLETED)
                    prompt = await _drain(finished)
            while in_flight:
                finished, in_flight = await asyncio.wait(
                    in_flight, return_when=asyncio.FIRST_COMPLETED)
                await _drain(finished)
        finally:
            # One window's failure ends the job, and the siblings still in flight are then work
            # nobody will read. Cancel them rather than leaving orphaned tasks to be destroyed
            # pending — and so the STT service gets its slots back immediately.
            for task in in_flight:
                task.cancel()
            if in_flight:
                await asyncio.gather(*in_flight, return_exceptions=True)
    except (media.DecodeFailed, TranscriberUnavailable) as e:
        return await _fail(store, bus, meeting_id=meeting_id, user_id=user_id, native=native,
                           reason=str(e), segments=total, log_event=log_event)
    except Exception as e:  # noqa: BLE001 — an unexpected fault is still the USER's failed upload
        log_event("upload_job_crashed", audience="system", level="error", span="uploads.job",
                  meeting_id=str(meeting_id), fields={"error": f"{type(e).__name__}: {e}"})
        return await _fail(store, bus, meeting_id=meeting_id, user_id=user_id, native=native,
                           reason=f"{type(e).__name__}: {e}", segments=total, log_event=log_event)
    finally:
        _cleanup(tmpdir)

    finished = _now()
    await _end_session(bus, meeting_id=meeting_id, native=native)
    await store.advance_upload(
        meeting_id, status="completed", end_time=_iso(finished),
        upload={"state": "done", "finished_at": _iso(finished), "segments": total,
                "transcribed_seconds": round(duration, 2),
                # The row must not advertise an object that has been deleted: a reader that trusts
                # `object_key` would 404 against storage rather than learn the source is gone.
                "object_key": object_key if keep_source else None,
                "source_deleted": not keep_source},
    )
    if not keep_source:
        # The blob existed to make the job restartable, and the job is over. Best-effort: a storage
        # hiccup must never turn a finished transcript into a failed upload — the row is already
        # `completed` and the user already has their report.
        try:
            await media_store.delete(object_key)
            log_event("upload_source_deleted", audience="system", span="uploads.job",
                      meeting_id=str(meeting_id), fields={"object_key": object_key})
        except Exception as e:  # noqa: BLE001
            log_event("upload_source_delete_failed", audience="system", level="warning",
                      span="uploads.job", meeting_id=str(meeting_id),
                      fields={"object_key": object_key, "error": str(e)})
    if transcript_finalizer is not None:
        # Flush the meeting's redis segments to Postgres NOW, the same way the lifecycle callback
        # finalizes a bot's meeting — a finished upload is durable when the user is told it is,
        # not whenever the next db-writer tick happens to run.
        try:
            await transcript_finalizer(meeting_id)
        except Exception as e:  # noqa: BLE001 — the db-writer loop is the backstop
            log_event("upload_finalize_failed", audience="system", level="warning",
                      span="uploads.job", meeting_id=str(meeting_id), fields={"error": str(e)})
    await _publish_status(bus, user_id=user_id, meeting_id=meeting_id, native=native,
                          status="completed", log_event=log_event)
    log_event("upload_transcribed", audience="user", span="uploads.job", user_id=user_id,
              meeting_id=str(meeting_id),
              fields={"segments": total, "duration_seconds": round(duration, 2)})
    return {"meeting_id": meeting_id, "status": "completed", "segments": total,
            "duration_seconds": round(duration, 2)}


async def _fail(store: UploadStore, bus: Bus, *, meeting_id: int, user_id: int, native: str,
                reason: str, segments: int, log_event: Callable) -> dict:
    """Record the failure on the row, close the session, and tell the user's live channel."""
    await _end_session(bus, meeting_id=meeting_id, native=native)
    await store.advance_upload(
        meeting_id, status="failed", end_time=_iso(_now()),
        upload={"state": "failed", "error": reason[:500], "finished_at": _iso(_now()),
                "segments": segments},
    )
    await _publish_status(bus, user_id=user_id, meeting_id=meeting_id, native=native,
                          status="failed", log_event=log_event)
    log_event("upload_failed", audience="user", level="warning", span="uploads.job",
              user_id=user_id, meeting_id=str(meeting_id),
              fields={"error": reason[:200], "segments": segments})
    return {"meeting_id": meeting_id, "status": "failed", "segments": segments, "error": reason}


def _cleanup(tmpdir: str) -> None:
    import shutil

    shutil.rmtree(tmpdir, ignore_errors=True)
