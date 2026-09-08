- **Bots carry their owner's name in the meeting (#0000).** The bot's in-meeting display name is now
  tagged with the requesting user's username — the local-part of their verified email (e.g. `Innova
  Toplantı Asistanı - alperenoz93`), never the full address — so operators can tell whose bot is
  whose in the participant list. It covers every spawn path (terminal UI, `POST /bots`, and calendar
  auto-join); the gateway already resolves the verified email and the identity `bot-context` now
  carries it for the auto-join sweep. Opt out with `VEXA_BOT_NAME_APPEND_OWNER=false`. See
  [Deployment](/deployment).
