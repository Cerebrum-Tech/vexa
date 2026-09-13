# Test host deployment and data migration

User authorization: deploy the redesigned version to `ikanaliztest.innova.com.tr`, retain the original
at `toplantiasistani.innova.com.tr`, and migrate user data/database. This is an isolated test deployment,
not an upstream release or replacement of production data.

Expected: test and original have distinct containers, networks, databases, Redis, workspace and object
volumes, and Docker workload prefixes. Existing user IDs, tokens, memberships, transcript rows, files,
Git history and recordings are retained in a timestamped copy. Test startup cannot resume original
workers, auto-join copied schedules, deliver copied webhooks or rewrite original data.

1. Inspect source settings, schemas, persistent mounts, route configuration and worker namespaces.
2. Back up PostgreSQL, Redis, workspaces, recordings and deployment configuration with restricted modes.
3. Build unique candidate images; prove namespace collision guard before starting test workloads.
4. Restore into separately named volumes, verify row counts/file manifests, migrate only proven legacy
   report/conversation identities, and suspend copied background automation in the test copy.
5. Start and verify test stack privately, including authenticated user views and migrations.
6. Route test host to candidate; route original host to original image. Verify both and record rollback.

No repository commits/pushes or external messages. Original data is read for cloning; all migration
mutations apply only to the test copy. Detailed credentials and user contents stay out of reports.

## Observations
Expected: existing domains are aliases for one terminal.
Actual: source VIRTUAL_HOST contains both names; runtime inspection confirms one source terminal.
Verdict: split routing after isolated candidate validation.

Expected: separate Compose project implies separate worker names.
Actual: Docker backend defaults every workload name to `vexa-` and on collision removes the matching
name. Separate network alone is insufficient. No test runtime/worker started.
Verdict: add explicit per-runtime name prefix and verify it before candidate startup.

## Completed observations — 2026-09-10

- **Copy:** snapshot recorded at 10:06 UTC / 13:06 Türkiye. Restored 13 users, 19 API tokens,
  50 meetings, 30 meeting sessions, 4,344 transcript segments and the empty platform-settings table.
  Row values match the source inventory except one token's `last_used_at`, which advanced on the
  original between the logical dump and inventory read; the clone retains the dump's timestamp.
- **Files:** all 2,282 workspace files (including hidden continuity and independent Git directories)
  and 2,499 MinIO files matched SHA-256 manifests. Object-store bytes: 4,092,613,634. Both source
  manifests were stable before/after their archives. Four workspace symlinks contain no external
  absolute targets. Backups and credentials are restricted under
  `/root/cerebrum/deployments/vexa-ui-test-20260910`.
- **Redis:** preserved 108 durable keys: six session metadata hashes, three session indexes,
  83 transcript/processed/output streams and 16 cursors/preferences. Executable queues, consumer
  groups, schedules and live workload state were not restored. All six saved chats reopen with
  prior turns. Calendar joins, routine reconciliation and copied webhooks are paused on the test copy.
- **Reports:** 12 completed Turkish reports have proven canonical row/session/owner attribution and
  now have committed per-run snapshots and matching DB descriptors. One incomplete report is retained
  as its original document. Browser verification exposed numeric filesystem owners versus the `seed`
  mount alias; migration now requires verified owner-to-mount mappings. Snapshot bodies are unchanged.
- **Isolation:** the runtime prefix and guarded Docker conflict changes passed 48 focused tests. The
  full runtime run passed 164 tests and skipped one, with its only failure caused by a missing Alpine
  image; after installing that test dependency, the real-container lifecycle test passed. An actual
  assistant test returned `TEST_OK`, mounted only the cloned workspace volume, and ran on the test
  network. The original worker was unchanged. The verification worker/conversation were cleaned up.
- **UI:** authenticated API lists match the original for all 13 users, including authorized shared
  meetings; unrelated transcript access is denied. Desktop/mobile checks against actual migrated data
  passed for all four report-owning users and all 12 report hashes. A six-toast mobile overlap was
  reproduced and fixed; the notification regression suite passes five tests. Recording playback
  returned HTTP 206 with 4,096 bytes from the copied object store. Browser checks report no page errors.
- **Routing:** the local nginx proxy returns HTTP 200 for both hosts. Test host JavaScript assets changed;
  original host assets and original terminal image are unchanged. All nine original backend containers
  retain their IDs/images. Authenticated WebSocket upgrades pass through both host routes. The resolved
  deployment configs and `manage.sh` preserve the split on restart and provide ordered route rollback.
- **Activity after cutover:** two new test meeting rows appeared while the final comparison ran; neither
  exists in the original. Snapshot comparisons therefore filter by the immutable snapshot row IDs.
  All 13 user checks pass again. New Teams row 53 became active; its bot and meeting worker use the new
  images and test-only network, and its live transcript stream contained 11 entries at observation.
  These new meetings were left running.
- **Checks:** final terminal image build, config-contract gate, architecture report, and whitespace check
  pass. Earlier full-suite baseline/environment failures remain documented in the UI continuation plan;
  this is a test deployment, with no source commits, push, or upstream release.

Verdict: the isolated test deployment and user-data copy are operating through the configured host route.
The original checkout remains clean. The copy is a point-in-time snapshot; later writes are independent.

Not checked: fresh LDAP credential login, completion/report generation for the newly active meeting,
and the upstream F5 HTTPS leg. Both preexisting hostnames resolve to `172.16.16.40` and their HTTPS connections time out
from this server. Browser host-route checks used the actual hostname through the local HTTP proxy;
they do not claim external TLS reachability. LDAP settings/cert mount and shared inference/STT endpoints
were preserved. Detailed evidence and rollback instructions are in the restricted deployment directory.
