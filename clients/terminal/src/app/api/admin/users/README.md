# users

Admin user list + create, proxied to admin-api's admin tier behind the verified admin gate.

Non-admins receive 404 from every route here, so the panel is invisible rather than forbidden.
The `X-Admin-API-Key` is used server-side only and never reaches the browser.
