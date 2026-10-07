# api/integrations (service-to-service routes)

Routes a system integrating with this deployment calls with a fixed deployment key instead of a
signed-in user's session. They forward only that key header and the query to the gateway — never the
session cookie's user key — and the backend owns the key check.

- `summaries/` — `GET /api/integrations/summaries?email=…` with `X-Summary-Api-Key`: one account's
  meeting summaries (gateway `/integrations/summaries` → agent-api `/api/integrations/summaries`).
