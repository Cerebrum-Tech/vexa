"""``POST /uploads`` · ``GET /uploads/{meeting_id}`` — the public surface of the uploads module.

The request handler does the three things that MUST happen while the caller is still on the wire —
land the bytes durably, mint the meeting row, queue the job — and nothing that takes minutes. The
transcode and the STT walk belong to the background loop (``service.run_upload_job``); a two-hour
recording is not a request/response.

Spooling is why the handler never holds the upload in memory: the multipart body is streamed to a
temp file in fixed-size reads, counted against the cap as it goes (a caller that lies in
``Content-Length`` is stopped by the counter, not by the header), then handed to object storage as
a path. The control plane's RSS is flat in the size of the upload.
"""
from __future__ import annotations

import os
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Callable, Optional

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from .ports import JobQueue, MediaStore, UploadStore

#: Containers and codecs a meeting recording plausibly arrives in — phone voice memos, screen
#: captures, conferencing exports, dictaphones, broadcast masters. ffmpeg reads all of them.
MEDIA_EXTENSIONS = frozenset({
    # video containers
    ".mp4", ".m4v", ".mov", ".qt", ".mkv", ".webm", ".avi", ".divx", ".wmv", ".asf", ".flv",
    ".f4v", ".mpg", ".mpeg", ".mpe", ".m1v", ".m2v", ".m2p", ".ts", ".m2ts", ".mts", ".vob",
    ".ogv", ".ogx", ".rm", ".rmvb", ".mxf", ".dv", ".y4m", ".3gp", ".3g2", ".swf",
    # audio containers / codecs
    ".mp3", ".mp2", ".mpga", ".m4a", ".m4b", ".m4r", ".aac", ".adts", ".wav", ".wave", ".bwf",
    ".flac", ".ogg", ".oga", ".opus", ".spx", ".weba", ".wma", ".amr", ".awb", ".3ga",
    ".aif", ".aiff", ".aifc", ".alac", ".ape", ".wv", ".ac3", ".eac3", ".dts", ".mka", ".caf",
    ".au", ".snd", ".ra", ".gsm", ".voc", ".w64", ".sln", ".tta", ".shn", ".mpc", ".dsf", ".dff",
})

#: Types that are definitely NOT a recording. These are refused at the door with a clear message —
#: the mistake they catch (dragging the agenda .pdf instead of the recording) is common, and the
#: alternative is storing a gigabyte, queueing a job, and answering with an ffmpeg parse error.
NON_MEDIA_EXTENSIONS = frozenset({
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf",
    ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".vtt", ".srt", ".sub", ".ass",
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".dmg", ".iso",
    ".exe", ".msi", ".dll", ".so", ".dylib", ".app", ".apk", ".deb", ".rpm", ".sh", ".bat", ".ps1",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".svg", ".heic", ".psd",
    ".pem", ".key", ".crt", ".p12", ".pfx", ".env",
})


def _refuses(ext: str) -> bool:
    """Is this extension one we KNOW is not a recording?

    The rule is deliberately asymmetric. A known-media extension passes, a known-NON-media
    extension is refused, and everything else — an unusual container, a codec this list has not
    heard of, a file a phone or an export tool wrote with no extension at all — is ACCEPTED and
    handed to ffmpeg, which decides by reading the bytes. A name is not evidence about content;
    ffmpeg is, and its refusal already becomes the job's stated failure reason. Erring the other
    way would mean this list quietly defines which recordings the product accepts, and every new
    device would be a bug report.
    """
    return ext in NON_MEDIA_EXTENSIONS


#: How much of the body is read per iteration while spooling.
_SPOOL_CHUNK = 1 << 20


def _default_log_event(*_args, **_kwargs) -> dict:
    return {}


def _resolve_user_id(x_user_id: Optional[str]) -> int:
    """The gateway injects ``x-user-id`` after it resolves ``x-api-key``. Missing → 401."""
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing user identity")
    try:
        return int(x_user_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid user identity")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _extension(filename: str) -> str:
    return os.path.splitext(filename or "")[1].lower()


async def _spool(upload: UploadFile, path: str, *, max_bytes: int) -> int:
    """Stream the multipart part to ``path``; raise 413 the moment it exceeds ``max_bytes``.

    Counted as it is read, so the cap holds against a truthful, an absent and a lying
    ``Content-Length`` alike."""
    written = 0
    with open(path, "wb") as fh:
        while True:
            chunk = await upload.read(_SPOOL_CHUNK)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"Upload exceeds the {max_bytes // (1024 * 1024)} MB limit",
                )
            fh.write(chunk)
    if written == 0:
        raise HTTPException(status_code=422, detail="Empty upload")
    return written


def build_router(
    store: UploadStore,
    media_store: MediaStore,
    queue: JobQueue,
    *,
    max_bytes: int = 1024 * 1024 * 1024,
    default_speaker: str = "Konuşmacı",
    default_language: Optional[str] = None,
    stt_configured: Optional[Callable[[], bool]] = None,
    spool_dir: Optional[str] = None,
    log_event: Callable[..., dict] = _default_log_event,
) -> APIRouter:
    """The uploads routes over the injected ports.

    ``stt_configured`` is the ``stt`` capability oracle (config.v1 tri-state). An upload with no
    transcription service behind it would land bytes and then fail every job, so the route refuses
    up front with the actionable 503 the capability contract mandates, rather than accepting work
    the deployment cannot do.
    """
    router = APIRouter()

    @router.post("/uploads", status_code=202)
    async def create_upload(
        file: UploadFile = File(...),
        title: Optional[str] = Form(None),
        language: Optional[str] = Form(None),
        speaker: Optional[str] = Form(None),
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        if stt_configured is not None and not stt_configured():
            raise HTTPException(
                status_code=503,
                detail="Transcription is not configured on this deployment "
                       "(TRANSCRIPTION_SERVICE_URL)",
            )
        filename = os.path.basename(file.filename or "recording")
        ext = _extension(filename)
        if _refuses(ext):
            raise HTTPException(
                status_code=415,
                detail=f"{ext} is not an audio or video recording — upload the meeting's "
                       f"recording (mp4, mkv, mov, webm, mp3, m4a, wav, flac, ogg, opus, amr, …)",
            )

        native = f"up-{uuid.uuid4().hex[:12]}"
        object_key = f"uploads/{user_id}/{native}/source{ext}"
        tmpdir = tempfile.mkdtemp(prefix="vexa-upload-in-", dir=spool_dir)
        tmp_path = os.path.join(tmpdir, f"source{ext}")
        try:
            size = await _spool(file, tmp_path, max_bytes=max_bytes)
            await media_store.upload_file(
                object_key, tmp_path,
                content_type=file.content_type or "application/octet-stream",
            )
        finally:
            import shutil

            shutil.rmtree(tmpdir, ignore_errors=True)

        upload = {
            "id": native, "filename": filename, "content_type": file.content_type,
            "bytes": size, "object_key": object_key,
            "language": (language or "").strip() or default_language,
            "speaker": (speaker or "").strip() or default_speaker,
            "state": "queued", "queued_at": _now_iso(),
            "duration_seconds": None, "transcribed_seconds": 0.0, "segments": 0, "error": None,
        }
        row = await store.create_upload_meeting(
            user_id, native_meeting_id=native, upload=upload,
            title=(title or "").strip()[:512] or filename,
        )
        await queue.submit({
            "meeting_id": row["id"], "user_id": user_id, "native_meeting_id": native,
            "object_key": object_key, "language": upload["language"],
            "speaker": upload["speaker"],
        })
        log_event("upload_accepted", audience="user", span="uploads.create", user_id=user_id,
                  meeting_id=str(row["id"]),
                  fields={"bytes": size, "extension": ext, "language": upload["language"]})
        return JSONResponse(status_code=202, content=row)

    @router.get("/uploads/{meeting_id}")
    async def get_upload(
        meeting_id: int,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        row = await store.get_upload(user_id, meeting_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"Upload {meeting_id} not found")
        return JSONResponse(content=row)

    return router
