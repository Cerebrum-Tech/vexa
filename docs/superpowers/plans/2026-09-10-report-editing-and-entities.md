# Meeting titles, real entity pages and editable summaries

Continue in the session-owned vexa-ui-continue worktree; deploy only the authorized test stack.

Expected: future Teams joins capture a real subject when available, preserving manual/calendar
names. Existing meeting 64 has no title in the database; request its intended title rather than
inventing the original. Unchanged default demo entities disappear from current test workspaces,
with private backups, and new default workspaces contain no demonstration people or companies.

Expected: the owner can edit the summary section, Save or Cancel explicitly, and retain drafts on
failure. The API checks canonical meeting ownership and current writable workspace access. It
sends a dedicated deterministic operation through the existing unit dispatcher and worker; no
model interprets the user's edited text. The worker compares the source revision, preserves all
other report sections and provenance, commits only the affected report artifacts, then confirms.

Expected: generated reports identify people and organizations in structured metadata with exact
supporting mentions from the report. The existing report producer materializes these as entity
pages in the same workspace before publishing readiness. Existing pages are reused, user content
is preserved, and source links identify the canonical meeting run. Untrusted names never become
filesystem paths directly. Existing reports are processed in the test workspace after a backed-up,
reviewable extraction pass; no example biography is carried into real entity pages.

Work can run in parallel: Teams capture/lifecycle, default-seed cleanup, recap editor, and the
worker/API report persistence and entity materialization. No two agents edit the same source file.

Validation: red-to-green ownership/revision/rollback/section-preservation tests; a real workspace
commit and isolated runtime edit probe; report entity creation/deduplication/negative controls;
source and deployed seed inventories; desktop/mobile browser save/cancel/conflict checks; production
builds; test-only service health and original container/hostname comparison. Record actual evidence
and limits here before completion. No source repository commits or external messages are needed.

Actual: source regressions witnessed missing title/platform, premature summary routes, demo defaults,
missing entity pages, report-only commits, entity mutation during commit, lock contention and rejected
JSON fences. Browser proof reads real owner report 64 and intercepts writes: zero requests during
typing/blur, Cancel unchanged, one explicit Save, conflict retains draft, mobile has no overflow.
598 terminal tests passed. 187 backend checks passed before the final entity fallback; 127 affected
checks passed after it. Watcher/unit metadata suites passed 56 tests with the repository seed directory,
and lifecycle suites passed 20 tests; join, bot adapter and TypeScript build checks passed. Dataflow,
Python isolation and Python graph gates passed; the full repository gate suite was not rerun.

Actual: a source-overlay worker with live Redis committed a real summary change in an isolated
workspace without model credentials. A real model report exposed transcript quotations in entity
metadata that did not appear in the summary; the new extraction fallback reproduced then repaired
this. The final model run created a canonical report, two person pages and one company page.

Actual: test-only migration archived full workspace/Git and PostgreSQL backups, removed three exact
demo files, created 19 pages from 25 verified mentions across 15 reports and repaired 15 platform
artifacts against owned database rows. All changes reached workspace history. Deployed owner Save
returned 200 through the actual runtime worker while preserving identical report bytes; stale revision
returned 409 and another owner returned 403. All 13 migrated account views passed. Deployed directory browser checks show the report person and Innova, with Jane Liu and Acme Corp absent. Both local Host
routes serve distinct builds; all ten original service containers retain their IDs and images.

Verdict: summary editing, empty defaults, evidence-backed entity creation and test deployment verified.
Teams title capture/propagation is fixture and seam verified; no fresh Teams call was joined. Existing
meeting 322077721440001 (row 64) has no stored original title; the requested title remains pending from
the user. External HTTPS via the upstream F5 VIP is not reachable from this server; local Host routing
and browser behavior were checked. No source commits, pushes or messages to others were made.
