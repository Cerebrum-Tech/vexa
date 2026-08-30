# tokens

A user's API tokens — list and mint. The token is the credential in this deployment.

Non-admins receive 404 from every route here, so the panel is invisible rather than forbidden.
The `X-Admin-API-Key` is used server-side only and never reaches the browser.
