# `/api/uploads` — the media-upload edge

`POST /api/uploads` (multipart: `file`, optional `title` · `language` · `speaker`) and
`GET /api/uploads?id=<meeting_id>` (transcription progress), both forwarded to the single gateway
edge with the per-user `X-API-Key` injected server-side from the cookie token.

Its own route file rather than the catch-all `/api/[...path]` because that proxy reads the body with
`await req.text()` and re-sends it as `application/json` — which destroys a multipart boundary and
buffers the whole recording in this process. Here the body is relayed as a stream (`duplex: "half"`)
with its Content-Type intact, so a gigabyte file passes through at constant memory.

Backend: `core/meetings/services/meeting-api/src/meeting_api/uploads` (`POST /uploads`).
