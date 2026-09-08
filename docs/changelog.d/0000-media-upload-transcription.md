- **Upload a recording and get a meeting (#0000).** A meeting nobody sent a bot to — a screen
  capture, a phone recording, an export from another tool — now becomes a meeting: `POST /uploads`
  (and **⤒ Kayıt yükle** in the terminal) takes an audio or video file, and you get the same
  transcript, the same row in your meetings list, and the same Turkish post-meeting report as a call
  the bot attended. There is no second pipeline: meeting-api decodes the file once with ffmpeg,
  walks it through the deployment's own STT service on the **deferred** tier (so a long upload
  queues behind live meetings instead of competing with them), and publishes the segments — and the
  closing `session_end` — on `transcription_segments`, the same wire the bot writes. The collector
  persists them, the live view fans them out, and the copilot arms and reports, none of it knowing a
  file rather than a call produced them. Progress is honest (`transcribed_seconds / duration_seconds`,
  advanced per window, served by `GET /uploads/{id}`), a restart mid-transcode resumes rather than
  stranding the row, and a failure is recorded on the meeting with its real reason. Whisper does not
  diarize, so every segment carries one speaker label (`VEXA_UPLOAD_SPEAKER_LABEL`, default
  `Konuşmacı`) rather than invented speakers. Needs `TRANSCRIPTION_SERVICE_URL`; without it the
  route answers 503 and names the key. Formats are whatever ffmpeg reads (76 named extensions), and
  the rule is asymmetric on purpose: a known non-recording (`.pdf`, `.zip`, `.png`) is refused at the
  door, while an unfamiliar or missing extension is accepted and ffmpeg decides by reading the bytes
  — a filename is not evidence about content. The source recording is deleted once its transcript
  exists (`VEXA_UPLOAD_KEEP_SOURCE=true` retains it); a failed upload keeps its source, because
  re-running it is the remedy. The per-file ceiling is 1 GB (`VEXA_UPLOAD_MAX_MB`) — match your
  reverse proxy's `client_max_body_size`. See
  [Upload a recording](/how-to/upload-a-recording) and [Meetings API](/api/meetings#upload-a-recording).
