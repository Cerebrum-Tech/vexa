# join/src/shared — cross-platform join helpers

`escalation.ts` — `startDebugView`: opens the live debug lens (VNC pixels on Linux, CDP
control anywhere) so a human/agent can see and unblock a stuck join (e.g. a reCAPTCHA
block). Imports host symbols from `../_host` and Node builtins only.

`page-crash.ts` — `guardAgainstPageCrash`: races a platform's join + admission drive against the
page's Playwright `crash` event, so a renderer the kernel kills mid-lobby rejects with a typed
transient `join_failure` instead of hanging the poll (and the container) forever. Wired once, in
`joinMeeting`, around every platform branch.
