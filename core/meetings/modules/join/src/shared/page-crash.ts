/**
 * Race a join/admission drive against the page dying under it.
 *
 * Playwright reports a renderer the kernel killed (host memory pressure picks the meeting tab's
 * renderer first — it is the largest child with a positive oom_score_adj) as the page's `crash`
 * event. A locator read that is in flight on that page never settles, so a polling admission wait
 * with no listener sits in its loop forever: the process stays up, the container stays alive, and
 * the control plane — which reaps only workloads the runtime reports gone — never converges the
 * meeting, leaving the user unable to request the same meeting again.
 *
 * The guard rejects the drive with a typed TRANSIENT `join_failure` the moment the page crashes,
 * so the bot exits `failed` and the control plane's retry policy decides what happens next.
 * Only `crash` is watched: `close` is also raised by the bot's own lobby withdrawal on a user stop,
 * which must keep its own terminal reason.
 *
 * A page without an event surface (the selector-only fakes the admission tests drive) runs `run`
 * unguarded.
 */
import type { Page } from "playwright";
import { AdmissionError } from "./admission";

export const PAGE_CRASH_REASON = "browser page crashed during the join (renderer gone)";

type Listener = () => void;
type EventSurface = { on(event: "crash", fn: Listener): unknown; off(event: "crash", fn: Listener): unknown };

function eventSurface(page: unknown): EventSurface | null {
  const p = page as Partial<EventSurface> & { removeListener?: EventSurface["off"] } | null | undefined;
  if (!p || typeof p.on !== "function") return null;
  const off = typeof p.off === "function" ? p.off : p.removeListener;
  if (typeof off !== "function") return null;
  return { on: p.on.bind(p), off: off.bind(p) };
}

export async function guardAgainstPageCrash<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const surface = eventSurface(page);
  if (!surface) return run();

  let onCrash: Listener = () => {};
  const crashed = new Promise<never>((_, reject) => {
    onCrash = () => reject(new AdmissionError("join_failure", PAGE_CRASH_REASON));
    surface.on("crash", onCrash);
  });
  try {
    return await Promise.race([run(), crashed]);
  } finally {
    surface.off("crash", onCrash);
  }
}
