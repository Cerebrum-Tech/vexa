### Added

- **Domain (LDAP/Active Directory) sign-in for the Terminal.** When a deploy sets the `LDAP_*`
  environment variables, the login card shows a "Domain ile giriş yap" form: users authenticate with
  their corporate directory account (bind-search-bind against the configured domain controllers, with
  LDAPS + a mounted CA bundle), and a Vexa account and token are provisioned for them on first login —
  the same find-or-create path the email/OAuth logins use. Disabled and hidden when `LDAP_*` is unset.
  See [Deployment](/deployment).
