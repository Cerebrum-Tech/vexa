"""uploads — a recording the bot never attended becomes a meeting.

Front door (P6): import from here, never a deep module path.

``POST /uploads`` takes an audio or video file, lands it in object storage, mints the meeting row
(``platform='upload'``) and queues a job. The background loop decodes it ONCE to 16 kHz mono PCM,
walks it window by window through the deployment's OpenAI-compatible STT service on the
``deferred`` tier, and XADDs the resulting segments onto ``transcription_segments`` — **the same
wire the bot writes**.

That last point is the whole design. Nothing downstream is taught about uploads: the collector
persists the segments and owns ``tc:meeting:{row}`` as its single writer (P23), the gateway fans
the live rows out, the agent watcher arms the meeting's copilot, and the terminating ``session_end``
frame — ordered behind every segment because it rides the same stream — reaps that copilot into its
post-meeting report. An uploaded recording yields exactly what an attended meeting yields.

Format policy is asymmetric on purpose: a known-media extension passes, a known NON-media one is
refused at the door, and anything else — an unusual container, or no extension at all — is accepted
and handed to ffmpeg, which decides by reading the bytes. A filename is not evidence about content.

The source recording is deleted from object storage once the transcript exists; it was only ever
stored so a job could survive a replica dying mid-transcode. A FAILED job keeps its source, because
re-running it is the remedy.

Speaker attribution is a single label (``speaker`` on the request, default ``Konuşmacı``): whisper
returns no diarization, and inventing speakers from nothing would be a producer writing data it
does not have.

Public surface:
  * ``build_router(store, media_store, queue, ...)`` — the mountable routes (the unified app mounts
    them): POST ``/uploads``, GET ``/uploads/{meeting_id}``.
  * ``run_upload_job(job, ...)`` — one upload, start to finish. The entrypoint's loop drives it;
    the tests drive it identically.
  * ``to_segments(...)`` — the pure verbose_json → transcript.v1 mapper.
  * ``media`` — the ffmpeg decode + silence-aware windowing (``decode_to_pcm``, ``iter_windows``,
    ``iter_windows_file``, ``wav_of``, ``DecodeFailed``).
  * ``UploadStore`` / ``MediaStore`` / ``Transcriber`` / ``Bus`` / ``JobQueue`` ports +
    ``TranscriberUnavailable``.
  * ``adapters`` — ``SqlAlchemyUploadStore`` · ``WhisperTranscriber`` · ``RedisJobQueue``.
  * ``fakes`` — the offline drivers.
"""
from __future__ import annotations

from . import media
from .media import DecodeFailed
from .ports import (
    Bus,
    JobQueue,
    MediaStore,
    Transcriber,
    TranscriberUnavailable,
    UploadStore,
)
from .router import MEDIA_EXTENSIONS, NON_MEDIA_EXTENSIONS, build_router
from .service import PLATFORM, SEGMENT_STREAM, run_upload_job, to_segments

__all__ = [
    "Bus",
    "DecodeFailed",
    "JobQueue",
    "MEDIA_EXTENSIONS",
    "NON_MEDIA_EXTENSIONS",
    "MediaStore",
    "PLATFORM",
    "SEGMENT_STREAM",
    "Transcriber",
    "TranscriberUnavailable",
    "UploadStore",
    "build_router",
    "media",
    "run_upload_job",
    "to_segments",
]
