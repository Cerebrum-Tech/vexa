# @vexa/transcribe-whisper — the shared stt.v1 egress

_meetings/ · module · the single chokepoint to the hosted Whisper service._

One concern: take a PCM window → call the hosted transcription-service (OpenAI-
compatible `verbose_json`) → return word-level segments, with the **low-confidence /
hallucination STT filter applied at source**. Both lanes drive the shared buffer,
which calls this via an injected `transcribe(pcm, prompt)` fn — so whisper knows
nothing of topology, naming, or confirmation.

- `isLowConfidenceSegment` drops acoustically-junk segments (bad logprob, high
  no-speech, runaway compression) before they reach the confirm loop.
- The known false Turkish subtitle credit `Altyazı M.K.` is removed before draft
  or confirmed text reaches either lane, including spelling/punctuation variants
  and credits embedded in speech or split across provider segments. Surrounding
  speech keeps its timestamps; word alignment is retained when it can be matched
  exactly, and omitted otherwise. Generic discussion of subtitles is preserved.
- WAV-encodes Float32 PCM, retries transient failures with backoff, 30s timeout.

## Surface
`TranscriptionClient` · `isLowConfidenceSegment` · `setLogger` · types
`TranscriptionWord/Segment/Result`, `TranscriptionClientConfig`. Front door:
[`src/index.ts`](src/index.ts).

## Verify
```bash
pnpm --filter @vexa/transcribe-whisper build
pnpm --filter @vexa/transcribe-whisper test   # confidence, HTTP errors/model, subtitle credits
```
The subtitle-credit regression uses a local HTTP server to exercise the actual
response boundary, with negative controls for legitimate speech and word timing.
`gate:node` runs the **offline** filter golden here; pipeline replay (3.2) and
live L4 exercise the downstream consumers. Covered by `gate:node`,
`gate:isolation`, `gate:exports`, `gate:readme`.
