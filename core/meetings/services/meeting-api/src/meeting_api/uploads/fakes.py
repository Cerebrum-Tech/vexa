"""In-memory doubles for the uploads ports — the offline lane (no redis, no S3, no ffmpeg, no GPU).

They exist so the tests drive ``router.build_router`` and ``service.run_upload_job`` — the SHIPPED
code — rather than a re-implementation of them.
"""
from __future__ import annotations

import json
import os
import shutil
from typing import Optional

from .ports import TranscriberUnavailable


class InMemoryUploadStore:
    """``UploadStore`` over a dict of rows.

    Projects EXACTLY the keys ``SqlAlchemyUploadStore._project`` returns — a fake that hands back
    more than production does is a fake that lets a route ship a field no real deployment serves.
    ``start_time`` / ``end_time`` are recorded in ``self.times`` for assertions instead.
    """

    def __init__(self):
        self.rows: dict[int, dict] = {}
        self.times: dict[int, dict] = {}
        self._next_id = 1

    @staticmethod
    def _project(row: dict) -> dict:
        return {
            "id": row["id"], "user_id": row["user_id"], "platform": row["platform"],
            "native_meeting_id": row["native_meeting_id"], "status": row["status"],
            "title": row["title"], "upload": dict(row["upload"]),
        }

    async def create_upload_meeting(self, user_id, *, native_meeting_id, upload, title=None):
        meeting_id = self._next_id
        self._next_id += 1
        self.rows[meeting_id] = {
            "id": meeting_id, "user_id": user_id, "platform": "upload",
            "native_meeting_id": native_meeting_id, "status": "requested",
            "title": title, "upload": dict(upload),
        }
        self.times[meeting_id] = {"start_time": None, "end_time": None}
        return self._project(self.rows[meeting_id])

    async def get_upload(self, user_id, meeting_id):
        row = self.rows.get(meeting_id)
        if row is None or row["user_id"] != user_id:
            return None
        return self._project(row)

    async def advance_upload(self, meeting_id, *, status=None, upload=None,
                             start_time=None, end_time=None):
        row = self.rows.get(meeting_id)
        if row is None:
            return None
        if upload:
            row["upload"] = {**row.get("upload", {}), **upload}
        if status is not None:
            row["status"] = status
        if start_time is not None:
            self.times[meeting_id]["start_time"] = start_time
        if end_time is not None:
            self.times[meeting_id]["end_time"] = end_time
        return self._project(row)


class InMemoryMediaStore:
    """``MediaStore`` over the local filesystem — files really are copied, so the job's
    download → decode path is exercised end to end."""

    def __init__(self, root: str):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self.deleted: list[str] = []

    def _path(self, key: str) -> str:
        return os.path.join(self.root, key.replace("/", "__"))

    async def upload_file(self, key, path, *, content_type):
        shutil.copyfile(path, self._path(key))

    async def download_file(self, key, path):
        shutil.copyfile(self._path(key), path)

    async def delete(self, key):
        self.deleted.append(key)
        try:
            os.remove(self._path(key))
        except FileNotFoundError:
            pass


class ScriptedTranscriber:
    """``Transcriber`` that answers each window from a script — one list of ``verbose_json`` rows
    per call, cycling the last entry once the script runs out. ``fail_with`` makes every call
    raise, which is how the failure path is driven."""

    def __init__(self, script: Optional[list] = None, *, fail_with: Optional[str] = None):
        self.script = list(script or [])
        self.fail_with = fail_with
        self.calls: list[dict] = []

    async def transcribe(self, wav: bytes, *, language=None, prompt=None):
        self.calls.append({"bytes": len(wav), "language": language, "prompt": prompt})
        if self.fail_with:
            raise TranscriberUnavailable(self.fail_with)
        if not self.script:
            return []
        idx = min(len(self.calls) - 1, len(self.script) - 1)
        return self.script[idx]


class RecordingBus:
    """``Bus`` that records every XADD/PUBLISH — the wire the assertions read."""

    def __init__(self):
        self.frames: list[tuple[str, dict]] = []
        self.published: list[tuple[str, dict]] = []

    async def xadd(self, stream: str, payload: dict):
        self.frames.append((stream, payload))
        return f"{len(self.frames)}-0"

    async def publish(self, channel: str, data: str):
        try:
            self.published.append((channel, json.loads(data)))
        except (ValueError, TypeError):
            self.published.append((channel, {"raw": data}))
        return 1

    def segments(self) -> list[dict]:
        """Every segment that reached the stream, in wire order."""
        out: list[dict] = []
        for _stream, payload in self.frames:
            if payload.get("type") == "transcription":
                out.extend(payload.get("segments") or [])
        return out

    def types(self) -> list[str]:
        return [payload.get("type") for _stream, payload in self.frames]


class InMemoryJobQueue:
    """``JobQueue`` over a list. ``claim`` never blocks — the tests drive ticks explicitly."""

    def __init__(self):
        self.jobs: list[tuple[str, dict]] = []
        self.acked: list[str] = []
        self._next = 1

    async def submit(self, job: dict) -> str:
        job_id = f"{self._next}-0"
        self._next += 1
        self.jobs.append((job_id, dict(job)))
        return job_id

    async def claim(self, *, count: int = 1, block_ms: int = 5000):
        claimed, self.jobs = self.jobs[:count], self.jobs[count:]
        return claimed

    async def ack(self, job_id: str) -> None:
        self.acked.append(job_id)
