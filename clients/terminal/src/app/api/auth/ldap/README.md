# `/api/auth/ldap` — domain sign-in

`POST {username, password}` authenticates against the corporate directory (see `src/lib/ldap.ts`),
then find-or-creates the Vexa user at admin-api and mints a login token — setting the same
`vexa-token` / `vexa-user-info` cookies as the email login path. `GET` returns `{enabled}` so the
login card renders the domain form only when `LDAP_*` config is present.
