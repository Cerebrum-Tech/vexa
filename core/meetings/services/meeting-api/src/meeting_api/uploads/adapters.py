"""Production adapters for the uploads ports — SQLAlchemy · httpx · redis streams.

Lazy-imported by the composition root only (``__main__.build_production_app``), exactly like the
other modules' adapters: SQLAlchemy, boto3 and redis are never imported during the gate venv's
test run, which drives the same service code through ``fakes.py``.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
from typing import Optional

from .ports import TranscriberUnavailable

#: The durable job stream + its consumer group. One group, N meeting-api replicas: a job is
#: delivered to exactly one of them, and a replica that dies mid-transcode leaves its entry PENDING
#: for a peer to reclaim (``UPLOAD_RECLAIM_MIN_IDLE_MS``) rather than losing it.
JOB_STREAM = "upload_jobs"
JOB_GROUP = "upload_workers"


class SqlAlchemyUploadStore:
    """``UploadStore`` over the shared meetings table (``sessions.models.Meeting``)."""

    def __init__(self, session_factory):
        self._session_factory = session_factory

    async def _row(self, db, meeting_id: int, *, lock: bool = False):
        from sqlalchemy import select

        from ..sessions.models import Meeting

        stmt = select(Meeting).where(Meeting.id == meeting_id)
        if lock:
            stmt = stmt.with_for_update()
        return (await db.execute(stmt)).scalars().first()

    @staticmethod
    def _project(m) -> dict:
        data = dict(m.data) if isinstance(m.data, dict) else {}
        return {
            "id": m.id, "user_id": m.user_id, "platform": m.platform,
            "native_meeting_id": m.platform_specific_id, "status": m.status,
            "title": data.get("title"), "upload": data.get("upload") or {},
        }

    async def create_upload_meeting(self, user_id, *, native_meeting_id, upload, title=None):
        from ..sessions.models import Meeting

        data: dict = {"upload": dict(upload), "transcribe_enabled": True, "auto_join": False}
        if title:
            data["title"] = title
        async with self._session_factory() as db:
            m = Meeting(
                user_id=user_id, platform="upload", platform_specific_id=native_meeting_id,
                status="requested", data=data,
            )
            db.add(m)
            await db.commit()
            await db.refresh(m)
            return self._project(m)

    async def get_upload(self, user_id, meeting_id):
        async with self._session_factory() as db:
            m = await self._row(db, meeting_id)
            if m is None or m.user_id != user_id:
                return None
            return self._project(m)

    async def advance_upload(self, meeting_id, *, status=None, upload=None,
                             start_time=None, end_time=None):
        """Read→modify→write under ONE row lock: a progress tick and the terminal write are the
        same row, and the old get+put pattern let one clobber the other."""
        from datetime import datetime

        from sqlalchemy.orm.attributes import flag_modified

        async with self._session_factory() as db:
            m = await self._row(db, meeting_id, lock=True)
            if m is None:
                return None
            data = dict(m.data) if isinstance(m.data, dict) else {}
            if upload:
                merged = dict(data.get("upload") or {})
                merged.update({k: v for k, v in upload.items()})
                data["upload"] = merged
            m.data = data
            flag_modified(m, "data")
            if status is not None:
                m.status = status
            if start_time is not None:
                m.start_time = datetime.fromisoformat(start_time.replace("Z", "+00:00")).replace(tzinfo=None)
            if end_time is not None:
                m.end_time = datetime.fromisoformat(end_time.replace("Z", "+00:00")).replace(tzinfo=None)
            await db.commit()
            await db.refresh(m)
            return self._project(m)


class WhisperTranscriber:
    """``Transcriber`` over the deployment's OpenAI-compatible STT service.

    Two things it does that a plain POST does not:

    * ``transcription_tier=deferred`` — an upload is batch work behind a live meeting. The service
      reserves realtime slots and answers 503 + ``Retry-After`` when the deferred lane is full,
      which is a SCHEDULE, not an error.
    * it honours that schedule — bounded retries on 503/429/timeouts with the server's own
      ``Retry-After``, then :class:`TranscriberUnavailable`, which the job records as the user's
      failure reason. It never returns an empty window as if it were silence.
    """

    def __init__(self, client, base_url: str, *, model: str = "whisper-1",
                 token: Optional[str] = None, max_attempts: int = 30,
                 max_backoff_s: float = 30.0):
        self._client = client
        self._base = base_url.rstrip("/")
        self._model = model
        self._token = token
        self._max_attempts = max_attempts
        self._max_backoff_s = max_backoff_s

    def _endpoint(self) -> str:
        # Accept a base ("https://stt.example") or a full endpoint already ending in the OpenAI
        # path — the same tolerance the terminal's dictation proxy applies to this env var.
        if self._base.endswith("/v1/audio/transcriptions"):
            return self._base
        return f"{self._base}/v1/audio/transcriptions"

    @staticmethod
    def _retry_after(resp, fallback: float) -> float:
        try:
            return max(0.5, float(resp.headers.get("retry-after") or fallback))
        except (TypeError, ValueError):
            return fallback

    async def transcribe(self, wav: bytes, *, language=None, prompt=None) -> list:
        import httpx

        files = {"file": ("window.wav", wav, "audio/wav")}
        data = {
            "model": self._model, "response_format": "verbose_json",
            "timestamp_granularities": "segment", "transcription_tier": "deferred",
            "temperature": "0",
        }
        if language:
            data["language"] = language
        if prompt:
            data["prompt"] = prompt[:800]
        headers = {"X-Transcription-Tier": "deferred"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
            headers["X-API-Key"] = self._token

        backoff = 1.0
        last = "no attempt was made"
        for attempt in range(1, self._max_attempts + 1):
            try:
                resp = await self._client.post(self._endpoint(), files=files, data=data,
                                               headers=headers)
            except httpx.HTTPError as e:
                last = f"{type(e).__name__}: {e}"
            else:
                if resp.status_code == 200:
                    body = resp.json()
                    return body.get("segments") or []
                if resp.status_code in (429, 503):
                    # Backpressure, not failure: the service is telling us when to come back.
                    wait = self._retry_after(resp, backoff)
                    last = f"HTTP {resp.status_code} (busy)"
                    await asyncio.sleep(min(wait, self._max_backoff_s))
                    backoff = min(backoff * 1.5, self._max_backoff_s)
                    continue
                if resp.status_code in (401, 403):
                    raise TranscriberUnavailable(
                        f"the transcription service rejected our credentials (HTTP {resp.status_code}) "
                        f"— check TRANSCRIPTION_SERVICE_TOKEN"
                    )
                raise TranscriberUnavailable(
                    f"transcription failed with HTTP {resp.status_code}: "
                    f"{resp.text[:200] if hasattr(resp, 'text') else ''}"
                )
            await asyncio.sleep(min(backoff, self._max_backoff_s))
            backoff = min(backoff * 1.5, self._max_backoff_s)
        raise TranscriberUnavailable(
            f"the transcription service stayed unavailable after {self._max_attempts} attempts "
            f"({last})"
        )


class RedisJobQueue:
    """``JobQueue`` over a redis stream + consumer group."""

    def __init__(self, client, *, stream: str = JOB_STREAM, group: str = JOB_GROUP,
                 consumer: Optional[str] = None, reclaim_min_idle_ms: int = 600_000,
                 consumer_ttl_ms: int = 30 * 60 * 1000, prune_every: int = 120):
        self._client = client
        self._stream = stream
        self._group = group
        self._consumer = consumer or f"upload-{socket.gethostname()}-{os.getpid()}"
        self._reclaim_min_idle_ms = reclaim_min_idle_ms
        # How long an ABANDONED consumer may sit before the sweep prunes it. Set WELL above the
        # reclaim window so a merely-quiet live replica — which re-registers on its very next read —
        # is never mistaken for a ghost.
        self._consumer_ttl_ms = consumer_ttl_ms
        self._prune_every = max(1, prune_every)
        self._ticks = 0
        self._ensured = False
        self._reclaim_cursor = "0-0"

    async def _ensure_group(self) -> None:
        if self._ensured:
            return
        try:
            # id="0": a job queued before this group existed must still run — unlike a transcript
            # tail, an unclaimed upload is work the user is waiting for, never stale traffic.
            await self._client.xgroup_create(name=self._stream, groupname=self._group, id="0",
                                             mkstream=True)
        except Exception as e:  # noqa: BLE001 — BUSYGROUP is the normal steady state
            if "BUSYGROUP" not in str(e):
                raise
        self._ensured = True

    async def submit(self, job: dict) -> str:
        await self._ensure_group()
        return await self._client.xadd(self._stream, {"payload": json.dumps(job)})

    @staticmethod
    def _decode(entries) -> list:
        out = []
        for entry_id, fields in entries or []:
            raw = fields.get("payload") if isinstance(fields, dict) else None
            if not raw:
                continue
            try:
                out.append((entry_id, json.loads(raw)))
            except (ValueError, TypeError):
                continue
        return out

    async def _prune_ghosts(self) -> None:
        """Drop consumers this group will never hear from again.

        Every container recreate mints a NEW consumer name (``upload-<host>-<pid>``) and leaves the
        old one in the group forever — nothing else removes it, so the roster grows by one on every
        deploy. The ``pending == 0`` guard is the load-bearing part: a consumer still holding an
        un-acked job is NEVER pruned, so this can only ever remove a ghost. Mirrors the collector's
        own ``COLLECTOR_CONSUMER_TTL_MS`` sweep, for the same reason and with the same guard."""
        try:
            consumers = await self._client.xinfo_consumers(self._stream, self._group)
        except Exception:  # noqa: BLE001 — hygiene; never block a claim on it
            return
        for c in consumers or []:
            name = c.get("name") if isinstance(c, dict) else None
            name = name.decode() if isinstance(name, (bytes, bytearray)) else name
            if not name or name == self._consumer:
                continue
            if int(c.get("pending") or 0) != 0:
                continue                      # still holds work — not a ghost
            if int(c.get("idle") or 0) < self._consumer_ttl_ms:
                continue                      # merely quiet; a live peer re-registers on its next read
            try:
                await self._client.xgroup_delconsumer(self._stream, self._group, name)
            except Exception:  # noqa: BLE001
                pass

    async def claim(self, *, count: int = 1, block_ms: int = 5000) -> list:
        await self._ensure_group()
        self._ticks += 1
        if self._ticks % self._prune_every == 0:
            await self._prune_ghosts()
        # Orphans FIRST: a replica killed mid-transcode leaves its entry delivered-but-un-acked,
        # and nothing else in the system would ever run that user's upload again.
        try:
            reclaimed = await self._client.xautoclaim(
                name=self._stream, groupname=self._group, consumername=self._consumer,
                min_idle_time=self._reclaim_min_idle_ms, start_id=self._reclaim_cursor,
                count=count,
            )
            if isinstance(reclaimed, (list, tuple)) and len(reclaimed) >= 2:
                self._reclaim_cursor = reclaimed[0] or "0-0"
                decoded = self._decode(reclaimed[1])
                if decoded:
                    return decoded
        except Exception:  # noqa: BLE001 — reclaim is hygiene; never block fresh work on it
            pass
        resp = await self._client.xreadgroup(
            groupname=self._group, consumername=self._consumer,
            streams={self._stream: ">"}, count=count, block=block_ms,
        )
        for _stream, entries in resp or []:
            decoded = self._decode(entries)
            if decoded:
                return decoded
        return []

    async def ack(self, job_id: str) -> None:
        await self._client.xack(self._stream, self._group, job_id)
