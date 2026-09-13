# Turkish subtitle-credit filter

Objective: remove the user-reported false `Altyazı M.K.` output from new test-host
transcriptions without removing surrounding speech or interrupting an active meeting.

Expected: a high-confidence STT HTTP response containing only the known credit
returns no text or segments. A mixed response retains its real speech and timing.
Spelling/punctuation variants, words split into tokens, and credits split across
provider segments are removed. Legitimate subtitle discussion and short speech
remain unchanged. No new public contract, module, or data flow is required.

Trace: Teams uses the mixed window predicate, whose list lacks the credit. Pending
buffer drafts can join a real segment and a credit without checking the credit
individually. The shared Whisper response parser precedes both draft and confirmed
output, making it the producer boundary for this fix.

Actual before fix: the local HTTP regression suite failed 14 positive cases while
all six legitimate-speech controls passed (`/tmp/vexa-subtitle-credit-red.log`).
Review added a seventh negative control: pruning low-confidence speech must not
invent a credit across originally nonadjacent words. That case was observed red,
then corrected by matching credits against the original segment sequence.
After the fix: all 21 cases passed, as did the existing confidence, typed-error,
retry, and model-request checks. TypeScript build passed. Running the same HTTP
suite in the previous bot image with the new compiled Whisper module mounted
read-only passed all 21 cases with external networking disabled.

The isolation check initially rejected legitimate `node:test` and
`node:assert/strict` imports in the added tests. The Whisper and join checkers now
use Node's `isBuiltin` API for builtins; the full 18-brick isolation gate passes.
Exports, README, and sealed-dataflow gates also pass.

Verdict: the response-boundary behavior is reproduced and verified before image
packaging. Rollout targets only the test runtime's bot image selection. Existing
meeting bots retain their running image; stored transcripts are not rewritten.
Deployment evidence and limitations are recorded in the test deployment directory.
