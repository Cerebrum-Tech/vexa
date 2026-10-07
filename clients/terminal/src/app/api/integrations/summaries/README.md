# api/integrations/summaries

`GET /api/integrations/summaries?email=<account email>[&since=<ISO>&until=<ISO>&limit=<1-200>]` with
header `X-Summary-Api-Key: <VEXA_SUMMARY_API_KEY>`. Forwards to the gateway's `/integrations/summaries`
and returns agent-api's answer verbatim: `{user, count, summaries: [{meeting_id, title, platform,
native_meeting_id, status, start_time, end_time, shared, language, revision, summary, content}]}`,
newest first. 401 wrong/missing key · 404 unknown email · 422 bad parameters · 503 key unset or an
upstream down.
