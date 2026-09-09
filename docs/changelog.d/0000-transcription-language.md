- **Deployment-wide transcription language.** `VEXA_TRANSCRIPTION_LANGUAGE` (meeting-api) is the
  whisper language code every transcription request is forced to when the caller names none —
  bot spawns on every path (UI, API, calendar auto-join) and `POST /uploads` alike. Unset keeps
  per-window auto-detect. A Turkish deployment sets `tr` so one noisy window can no longer flip
  the rest of the meeting into another language. The terminal's composer dictation (`/api/stt`)
  sends the same key, so a spoken question is decoded in the meeting's language too.
