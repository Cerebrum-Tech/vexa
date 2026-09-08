"""The ports the uploads module is written against — every collaborator injected (P2/P3).

An uploaded recording is a meeting the bot never attended. The module therefore needs exactly four
capabilities, and nothing else:

  * :class:`MediaStore`  — object storage for the source media (the ``recordings`` S3 adapter
    satisfies it structurally; the source blob is what makes a job restartable after a crash).
  * :class:`UploadStore` — the meeting row: create it, advance its status, merge the ``upload``
    progress record into ``meeting.data``.
  * :class:`Transcriber` — one OpenAI-compatible ``/v1/audio/transcriptions`` call per window.
  * :class:`Bus`         — XADD onto ``transcription_segments``. Deliberately the SAME wire the bot
    writes: the collector persists the segments, owns ``tc:meeting:{row}`` as its single writer
    (P23), and the agent watcher arms the copilot off the very same frames. Nothing downstream of
    the stream knows — or needs to know — that a file rather than a bot produced them.

  * :class:`JobQueue`    — the durable hand-off from the request handler to the background loop.

Each is a ``Protocol``: the production adapters live in ``adapters.py``, the in-memory doubles in
``fakes.py``, and the tests drive the SAME service code as production.
"""
from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable


@runtime_checkable
class MediaStore(Protocol):
    """Object storage for the uploaded source media — FILE-based on purpose.

    A meeting recording is hundreds of megabytes; ``bytes``-in/``bytes``-out (the recordings
    ``Storage`` port's chunk shape, sized for a bot's seconds-long chunks) would hold the whole
    upload in the control plane's RSS twice over. Both directions therefore go through a path on
    disk, which boto3 streams in fixed-size parts."""

    async def upload_file(self, key: str, path: str, *, content_type: str) -> None: ...

    async def download_file(self, key: str, path: str) -> None: ...

    async def delete(self, key: str) -> None: ...


@runtime_checkable
class UploadStore(Protocol):
    """The meetings-row writes an upload needs. Owner-scoped everywhere a user id is passed."""

    async def create_upload_meeting(
        self, user_id: int, *, native_meeting_id: str, upload: dict, title: Optional[str] = None,
    ) -> dict:
        """INSERT the meeting row for an upload — ``platform='upload'``, status ``requested``,
        ``data.upload`` seeded with ``upload`` (and ``data.title`` when given). Returns the row as
        ``{id, user_id, platform, native_meeting_id, status, upload}``."""
        ...

    async def get_upload(self, user_id: int, meeting_id: int) -> Optional[dict]:
        """The caller's OWN upload row, or ``None`` (→ 404). Never resolves another user's row."""
        ...

    async def advance_upload(
        self, meeting_id: int, *, status: Optional[str] = None, upload: Optional[dict] = None,
        start_time: Optional[str] = None, end_time: Optional[str] = None,
    ) -> Optional[dict]:
        """Advance the row: set ``status`` and/or MERGE ``upload`` into ``data.upload`` under the
        row lock (a progress tick and a terminal write must not clobber each other). Keys whose
        value is ``None`` are left alone; the merge is shallow. Returns the row, or ``None`` when
        it is gone."""
        ...


@runtime_checkable
class Transcriber(Protocol):
    """One OpenAI-compatible speech-to-text call. ``wav`` is a complete 16 kHz mono RIFF window."""

    async def transcribe(
        self, wav: bytes, *, language: Optional[str] = None, prompt: Optional[str] = None,
    ) -> list[dict]:
        """Return the window's ``verbose_json`` segments — ``{start, end, text}`` in SECONDS
        RELATIVE TO THE WINDOW. Raises :class:`TranscriberUnavailable` when the service is
        unreachable or out of capacity after its own retries."""
        ...


class TranscriberUnavailable(RuntimeError):
    """The STT service could not be reached / stayed out of capacity. The job fails LOUD (P18):
    the user is told their upload failed and why, never left with a silently empty transcript."""


@runtime_checkable
class Bus(Protocol):
    """The collector's ``RedisBus`` shape — XADD onto a stream, PUBLISH onto a channel."""

    async def xadd(self, stream: str, payload: dict) -> Any: ...

    async def publish(self, channel: str, data: str) -> Any: ...


@runtime_checkable
class JobQueue(Protocol):
    """The durable queue between ``POST /uploads`` and the background transcribe loop.

    Durable rather than an ``asyncio`` task because the work outlives the request by minutes: a
    meeting-api restart mid-transcode must resume the job, not strand a row in ``active`` forever
    with no worker and no error."""

    async def submit(self, job: dict) -> str: ...

    async def claim(self, *, count: int = 1, block_ms: int = 5000) -> list[tuple[str, dict]]:
        """Claim up to ``count`` jobs — ``[(job_id, job)]``. Blocks up to ``block_ms``."""
        ...

    async def ack(self, job_id: str) -> None: ...
