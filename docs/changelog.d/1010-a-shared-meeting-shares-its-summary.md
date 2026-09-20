### Fixed

- **A meeting shared with you now shows its summary.** "Oturumu paylaş" grants the recipient the
  meeting — transcript, live feed — but the report is written into the OWNER's workspace, and the
  client read it through the workspace API, which only ever sees the caller's own mounts. The file was
  therefore never found, and the recipient watched "Özet hazırlanıyor…" for twenty minutes before being
  told the summary was "not ready yet"; both messages were false, since the report had been written
  hours earlier. `GET /api/meeting/{id}/report` now serves it under the authorization meeting-api
  already applies to the meeting itself (owner · member of the bound workspace · redeemer of a
  transcript share). The path is derived from the row rather than taken from the caller, the report's
  frontmatter must bind back to that row, and the file must match git HEAD — so exactly one meeting's
  committed report is reachable, and nothing else in the owner's workspace is addressable. Editing is
  unchanged: the summary editor stays owner-only, on both sides.
- **The share panel no longer slides under the sidebar.** Anchored to the button's right edge, the
  280px panel opened leftwards and on a narrow window ran past the content area; it now opens from the
  button's left edge, is clamped to the viewport, and its controls wrap instead of squeezing.
