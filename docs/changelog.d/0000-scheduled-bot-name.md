- **A scheduled meeting's bot carries the deployment's name again (#0000).** A deployment configured
  as `DEFAULT_BOT_NAME="Innova Toplantı Asistanı"` still joined **scheduled** meetings as "Vexa".
  Identity's `/internal/users/{id}/bot-context` returned a literal `"Vexa"` whenever the user had
  chosen no name, and that invented value reaches `bot_spawn` as an *explicit* `bot_name` — which
  outranks the operator's default (`_display_bot_name`: `bot_name or DEFAULT_BOT_NAME or VexaBot-…`).
  Only the scheduled path was affected, because the terminal's manual send passes a name of its own,
  which is why it looked correct everywhere an operator would think to check. Identity now reports
  the name the user CHOSE, or nothing; nothing is what lets the deployment default apply. The same
  invention is removed from the calendar-connection surfaces, where it was worse: connecting a
  calendar **persisted** `"Vexa"`, and auto-join reads a connection's stored name ahead of the
  deployment default — so the wrong name would have outlived the fix. Reported by an Innova operator.
