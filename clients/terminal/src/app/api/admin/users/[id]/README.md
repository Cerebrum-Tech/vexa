# [id]

One user: quota and profile edit (PATCH). Deletion is not exposed.

Non-admins receive 404 from every route here, so the panel is invisible rather than forbidden.
The `X-Admin-API-Key` is used server-side only and never reaches the browser.
