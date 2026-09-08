- **A large upload is no longer killed at five minutes (#0000).** Node's HTTP server defaults
  `requestTimeout` to 300 s, and when a request BODY outlives it Node destroys the request and
  answers a bare `400 Bad Request` — before any handler runs, so nothing in the app logs a reason.
  A 666 MB recording over a corporate link crosses 300 s comfortably, while the same file from
  localhost finishes in seconds, which is precisely why this survived every local test: the bug is a
  function of the user's bandwidth, not of the file. The terminal's server now allows 30 minutes for
  a request body (`VEXA_TERMINAL_REQUEST_TIMEOUT_MS`), aligned with the reverse proxy's own upload
  timeouts so no hop cuts an upload short of another. `headersTimeout` stays at 60 s: headers arrive
  at once, so a slow header is still a stalled client and still dropped — it is the body that is
  legitimately slow.
- **An upload failure now names itself.** The UI ended any unmapped status in a bare
  "Kayıt yüklenemedi.", which is what the operator above could report: no status, no layer, nothing
  to search a log for. An unrecognised status now carries the code and says the answer may have come
  from an intermediary rather than the app, `status === 0` is reported as a connection that never
  completed, and the raw exchange is written to the browser console.
