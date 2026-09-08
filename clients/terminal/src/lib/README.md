# `src/lib` — terminal server helpers

Framework-agnostic helpers used by the terminal's Next.js server routes.

- **`ldap.ts`** — corporate LDAP/LDAPS (Active Directory) authentication for the sign-in card.
  Bind-search-bind against the configured domain controllers; returns the directory profile that
  `src/app/api/auth/ldap/route.ts` turns into a Vexa token. All configuration is `LDAP_*`
  environment variables (P14) — no host, DN, or password is ever a literal.
