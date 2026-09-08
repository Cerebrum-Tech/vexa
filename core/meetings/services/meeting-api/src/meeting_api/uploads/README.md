# uploads — a recording the bot never attended becomes a meeting

`POST /uploads` takes an audio or video file and produces everything an attended meeting produces:
a transcript, a live row in the meetings list, and the post-meeting report.

## The one design decision

The job XADDs its segments onto **`transcription_segments`** — the same stream the bot writes.
Nothing downstream is taught about uploads:

| downstream | what it does, unchanged |
|---|---|
| collector (`collector/ingest.py`) | persists each segment, writes `tc:meeting:{row}` as its single writer (P23), publishes `tc:…:mutable` |
| gateway `/ws` | fans the live rows out to the terminal |
| agent watcher (`transcription_watcher.py`) | arms the meeting's copilot on the first frame |
| copilot worker | reaps on `session_end` and writes the post-meeting report |

The terminating `session_end` frame rides that same stream, so it is ordered **behind** every
segment it follows. The report can therefore never be authored against a half-drained transcript,
and no sleep/poll is needed to make that true.

## The flow

```
POST /uploads   spool → object storage (uploads/{user}/{native}/source.ext)
                meeting row: platform=upload, status=requested, data.upload={…}
                XADD upload_jobs                                       → 202
background loop download → ffmpeg → 16 kHz mono s16le PCM (ONE pass)
                iter_windows (cut at the quietest point near each boundary)
                  → POST /v1/audio/transcriptions  (tier: deferred)
                  → XADD transcription_segments  {type: transcription, …}
                  → data.upload.transcribed_seconds  (the progress bar)
                XADD transcription_segments  {type: session_end, …}
                status=completed, transcript finalized to Postgres
```

## Front door
- `build_router(store, media_store, queue, ...)` — POST `/uploads`, GET `/uploads/{meeting_id}`.
- `run_upload_job(job, ...)` — one upload start to finish; the entrypoint's loop drives it and the
  tests drive it identically (no background loop lives in this module).
- `to_segments(...)` — the pure `verbose_json` → transcript.v1 mapper.
- `media` — `decode_to_pcm` · `iter_windows` / `iter_windows_file` · `wav_of` · `DecodeFailed`.
- `UploadStore` / `MediaStore` / `Transcriber` / `Bus` / `JobQueue` ports + `TranscriberUnavailable`.
- `adapters` — `SqlAlchemyUploadStore` · `WhisperTranscriber` · `RedisJobQueue`.
- `fakes` — the offline drivers.

## Things worth knowing

- **One ffmpeg pass, then arithmetic.** 16 kHz mono s16le is 32000 bytes/second, so a window is a
  byte slice and a timestamp is a division. Seeking per window would be quadratic (accurate seek)
  or drift the timestamps (fast seek).
- **Windows are cut at the quietest point** within ±10 s of the nominal boundary. Whisper
  transcribes each window independently, so a cut mid-word produces two half-words nothing
  downstream recovers.
- **`deferred` tier.** An upload is batch work behind a live meeting; the STT service reserves
  realtime slots and answers 503 + `Retry-After`, which the client honours as a schedule, not an
  error. It never returns an empty window as if it were silence.
- **One speaker.** Whisper does not diarize. The label comes from the request (`speaker`, default
  `Konuşmacı`); inventing speakers would be a producer writing data it does not have.
- **The format check is asymmetric.** A known-media extension passes, a known NON-media one
  (`.pdf`, `.zip`, `.png`, `.exe`) is refused at the door, and *everything else* — an unusual
  container, or no extension at all — is accepted and handed to ffmpeg, which decides by reading the
  bytes. A filename is not evidence about content, and the alternative makes this list, rather than
  the decoder, the definition of which recordings the product accepts.
- **The source is deleted once the transcript exists.** The blob was stored only so a job could
  survive a replica dying mid-transcode; past that it is a duplicate gigabyte. A FAILED job keeps its
  source — re-running it is the remedy. `VEXA_UPLOAD_KEEP_SOURCE=true` retains everything.
- **Attempts live on the row.** A job that kills its replica is reclaimed from the pending list by
  a peer; `data.upload.attempts` is what stops that being forever.
