- **Other systems can read an account's meeting summaries by email.** `GET /integrations/summaries?email=…`
  (also served by the terminal at `/api/integrations/summaries`) returns the account's completed meeting
  summaries, newest first. It supports `since`/`until`/`limit` and returns the short summary plus the full
  report for each meeting. The caller presents a fixed deployment key in `X-Summary-Api-Key`
  (`VEXA_SUMMARY_API_KEY`); with no key configured the route stays off.
