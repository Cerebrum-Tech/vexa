"""Media decode + windowing — the only part of an upload that touches ffmpeg.

ONE ffmpeg pass turns whatever the user uploaded (mp4 · mkv · mov · webm · mp3 · m4a · wav · ogg)
into the single representation the rest of the module speaks: **raw 16 kHz mono signed-16-bit
little-endian PCM on disk**. Everything after that is arithmetic — 32000 bytes per second, so a
window is a byte slice and a timestamp is a division.

Why one pass and not ``ffmpeg -ss`` per window: seeking per window re-decodes the file from the
start each time (accurate seek) or lands on a keyframe (fast seek). The first is quadratic on a
two-hour recording, the second drifts the timestamps we then hand the user as transcript offsets.
A single sequential decode is linear and exact.

Windows are cut at the QUIETEST point near their nominal boundary (:func:`split_offset`), not at
the nominal boundary itself: whisper transcribes each window independently, so a cut mid-word
produces two half-words that no amount of downstream cleanup recovers. The search is a cheap
energy scan over the PCM we already have on disk.
"""
from __future__ import annotations

import array
import asyncio
import os
import struct
from typing import Iterator, Optional

#: The pipeline's one audio format. 16 kHz mono is what whisper resamples to anyway, and 16-bit
#: PCM makes every offset exact integer arithmetic.
SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
BYTES_PER_SECOND = SAMPLE_RATE * SAMPLE_WIDTH


class DecodeFailed(RuntimeError):
    """ffmpeg refused the file (not media, a truncated container, an unsupported codec). The user
    gets this back as a 422-shaped failure on their upload, with ffmpeg's own last words."""


def _align(offset: int) -> int:
    """Snap a byte offset onto a whole sample — a slice starting mid-sample inverts the bytes of
    every sample after it and turns the window into noise."""
    return offset - (offset % SAMPLE_WIDTH)


async def decode_to_pcm(src_path: str, dst_path: str, *, ffmpeg: str = "ffmpeg") -> int:
    """Decode ``src_path`` → 16 kHz mono s16le PCM at ``dst_path``. Returns the PCM byte count.

    ``-vn`` drops the video stream (an uploaded meeting is usually a screen recording; we want the
    audio and nothing else). ``-nostdin`` matters in a server: without it ffmpeg inherits the
    process stdin and can block forever waiting on a terminal that will never answer.
    """
    proc = await asyncio.create_subprocess_exec(
        ffmpeg, "-nostdin", "-v", "error", "-i", src_path,
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le",
        "-y", dst_path,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = (stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise DecodeFailed(detail[-1] if detail else f"ffmpeg exited {proc.returncode}")
    size = os.path.getsize(dst_path)
    if size < BYTES_PER_SECOND // 10:  # < 100 ms of audio
        raise DecodeFailed("the file carries no audio track (or less than 100 ms of it)")
    return size


def duration_seconds(pcm_bytes: int) -> float:
    return pcm_bytes / BYTES_PER_SECOND


def wav_of(pcm: bytes) -> bytes:
    """Wrap raw PCM in a canonical 44-byte RIFF/WAVE header — what the STT endpoint's ``soundfile``
    decode expects, so no ffmpeg fallback runs on the transcription side."""
    n = len(pcm)
    return b"".join((
        b"RIFF", struct.pack("<I", 36 + n), b"WAVEfmt ",
        struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * SAMPLE_WIDTH,
                    SAMPLE_WIDTH, 8 * SAMPLE_WIDTH),
        b"data", struct.pack("<I", n), pcm,
    ))


def split_offset(pcm: bytes, nominal: int, *, radius_bytes: int, probe_bytes: int) -> int:
    """The quietest sample-aligned offset within ``±radius_bytes`` of ``nominal`` — where to cut.

    Scores each candidate by the mean absolute amplitude of the ``probe_bytes`` window that STARTS
    there, and takes the minimum: cutting into the quietest stretch is cutting between words. The
    scan strides rather than reads every sample (a 10-second radius at 16 kHz is 160k samples and
    this runs once per window), which is ample to find a pause.

    Falls back to ``nominal`` when the search range is degenerate — a boundary is always produced.
    """
    lo = max(0, _align(nominal - radius_bytes))
    hi = min(len(pcm) - probe_bytes, _align(nominal + radius_bytes))
    if hi <= lo:
        return _align(max(0, min(nominal, len(pcm))))
    step = max(SAMPLE_WIDTH, _align(probe_bytes // 4))
    best_offset, best_score = nominal, None
    for offset in range(lo, hi + 1, step):
        samples = array.array("h")
        samples.frombytes(pcm[offset:offset + probe_bytes])
        if not samples:
            continue
        # Stride the probe too: every 8th sample is a faithful loudness estimate at 16 kHz and
        # keeps the whole scan linear in the radius rather than in radius × probe.
        window = samples[::8] or samples
        score = sum(abs(s) for s in window) / len(window)
        if best_score is None or score < best_score:
            best_offset, best_score = _align(offset), score
    return best_offset


def _windows(read, total: int, *, window_bytes: int, radius: int, probe: int):
    """The windowing core, over a ``read(offset, length) -> bytes`` accessor.

    Reads at most ``window + radius + probe`` bytes at a time (≈ one window plus its search
    lookahead), so a six-hour recording costs the same memory as a six-minute one — the reason this
    is written against an accessor rather than a ``bytes`` argument.
    """
    start = 0
    while start < total:
        nominal = start + window_bytes
        if nominal >= total - radius:
            # The tail is never split: a stub window transcribes badly, and there is nothing after
            # it to carry the remainder.
            buf = read(start, total - start)
            if not buf:
                return
            yield start / BYTES_PER_SECOND, buf
            return
        buf = read(start, window_bytes + radius + probe)
        if not buf:
            return
        end = split_offset(buf, window_bytes, radius_bytes=radius, probe_bytes=probe)
        if end <= 0:
            end = min(len(buf), window_bytes)
        yield start / BYTES_PER_SECOND, buf[:end]
        start += end


#: The boundary search never reaches further than a TENTH of the window (capped at 10 s). A radius
#: that is a large fraction of the window is not a nudge onto a pause — it changes how many windows
#: the recording has, and at the tail it can swallow the last window whole.
def default_search_s(window_s: float) -> float:
    return min(10.0, window_s / 10.0)


def _bounds(window_s: float, search_s, probe_s: float) -> "tuple[int, int, int]":
    if search_s is None:
        search_s = default_search_s(window_s)
    return (
        max(BYTES_PER_SECOND, _align(int(window_s * BYTES_PER_SECOND))),
        _align(int(search_s * BYTES_PER_SECOND)),
        max(SAMPLE_WIDTH, _align(int(probe_s * BYTES_PER_SECOND))),
    )


def iter_windows(
    pcm: bytes, *, window_s: float, search_s: Optional[float] = None, probe_s: float = 0.25,
) -> Iterator["tuple[float, bytes]"]:
    """Yield ``(start_seconds, pcm_window)`` covering ``pcm`` exactly once — no overlap, no gaps.

    Each boundary except the last moves to the quietest point within ``±search_s`` of its nominal
    position (default: a tenth of the window), so the windows tile the recording without ever
    cutting a word."""
    window_bytes, radius, probe = _bounds(window_s, search_s, probe_s)
    return _windows(lambda o, n: pcm[o:o + n], len(pcm),
                    window_bytes=window_bytes, radius=radius, probe=probe)


def iter_windows_file(
    path: str, total: int, *, window_s: float, search_s: Optional[float] = None, probe_s: float = 0.25,
) -> Iterator["tuple[float, bytes]"]:
    """:func:`iter_windows` against a PCM file on disk — the production path.

    The decoded PCM of a long meeting is hundreds of megabytes (32000 bytes per second); holding it
    whole in the control plane would make the process's RSS a function of the longest recording any
    tenant uploads. Only the current window plus its search lookahead is ever resident."""
    window_bytes, radius, probe = _bounds(window_s, search_s, probe_s)
    with open(path, "rb") as fh:
        def read(offset: int, length: int) -> bytes:
            fh.seek(offset)
            return fh.read(length)

        yield from _windows(read, total, window_bytes=window_bytes, radius=radius, probe=probe)
