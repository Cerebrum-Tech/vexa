/**
 * guardAgainstPageCrash — a join drive whose page crashes under it rejects with a typed transient
 * join_failure instead of hanging forever.
 *
 * Reproduces the incident shape without a browser: the drive is a promise that never settles (the
 * hung `isVisible()` read on a dead renderer); the page is an EventEmitter that raises `crash`.
 *
 * Run: npx tsx src/shared/page-crash.test.ts
 */

import { EventEmitter } from "node:events";
import { guardAgainstPageCrash, PAGE_CRASH_REASON } from "./page-crash";
import { AdmissionError } from "./admission";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const never = () => new Promise<boolean>(() => {});
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. A crash during a hung drive → typed transient join_failure, listener released.
  {
    const page = new EventEmitter();
    const drive = guardAgainstPageCrash(page as any, never);
    await tick(10);
    check("crash listener is armed while the drive runs", page.listenerCount("crash") === 1);
    page.emit("crash");
    let err: unknown;
    try { await drive; } catch (e) { err = e; }
    check("hung drive rejects on crash", err instanceof AdmissionError, String(err));
    check("outcome is the transient join_failure", (err as AdmissionError)?.outcome === "join_failure");
    check("reason names the crash", (err as AdmissionError)?.message === PAGE_CRASH_REASON);
    check("crash listener is released after rejection", page.listenerCount("crash") === 0);
  }

  // 2. A drive that completes returns its value; nothing is left attached to the page.
  {
    const page = new EventEmitter();
    const out = await guardAgainstPageCrash(page as any, async () => "admitted");
    check("completed drive returns its own value", out === "admitted");
    check("crash listener is released after completion", page.listenerCount("crash") === 0);
    page.emit("crash"); // a late crash after completion must be inert (no unhandled rejection)
    await tick(5);
    check("late crash after completion is inert", true);
  }

  // 3. The drive's own typed verdict passes through unchanged.
  {
    const page = new EventEmitter();
    let err: unknown;
    try {
      await guardAgainstPageCrash(page as any, async () => { throw new AdmissionError("denial", "host said no"); });
    } catch (e) { err = e; }
    check("drive's own AdmissionError is preserved", (err as AdmissionError)?.outcome === "denial");
    check("listener released after drive rejection", page.listenerCount("crash") === 0);
  }

  // 4. A page with no event surface (selector-only fakes) runs the drive unguarded.
  {
    const out = await guardAgainstPageCrash({ locator: () => ({}) } as any, async () => 42);
    check("page without on/off is a passthrough", out === 42);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

process.on("unhandledRejection", (e) => { console.log(`  \x1b[31mFAIL\x1b[0m  unhandled rejection — ${String(e)}`); process.exit(1); });
main();
