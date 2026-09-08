"use client";

import { useEffect, useState } from "react";
import { readWorkspaceFile } from "../surfaces/workspaceApi";
import { MdxDoc } from "../ui-kit/MdxDoc";

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "past"]);

/** The wait budget for the post-meeting write turn.
 *
 *  The old budget was 45 × 2 s = 90 SECONDS, which was never the shape of the work it waited for. The
 *  report is authored by a model turn that first summarizes a long meeting in chunks and then writes
 *  from those digests; on a 77-minute recording that is minutes of GPU, not seconds. The panel
 *  therefore declared "oluşturulamadı" on essentially every real meeting — including ones whose
 *  report landed correctly a few minutes later — and the operator reported exactly that: *her
 *  toplantıda bunu diyo*.
 *
 *  So: poll FAST at first (a short meeting really is ready in seconds), then slowly, up to a budget
 *  that matches how the report is actually produced. And when the budget runs out, say the report is
 *  NOT READY — which is true and recoverable — rather than that it FAILED, which usually was not. */
export const RETRY_DELAY_MS = 2000;          // first phase: a short meeting is ready in seconds
export const SLOW_RETRY_DELAY_MS = 10_000;   // after that: a long one is minutes of model time
export const FAST_ATTEMPTS = 30;             // 30 × 2 s  = the first minute
export const MAX_ATTEMPTS = 144;             // + 114 × 10 s ⇒ a ~20 minute budget

/** The delay before attempt ``n`` (0-based) — fast while a quick report is plausible, then patient. */
export function retryDelayMs(attempt: number): number {
  return attempt < FAST_ATTEMPTS ? RETRY_DELAY_MS : SLOW_RETRY_DELAY_MS;
}

type RecapState =
  | { kind: "loading" }
  | { kind: "ready"; body: string }
  | { kind: "pending" };

function isTurkishRecap(content: string): boolean {
  return /^## Özet\s*$/m.test(content)
    && /^## Alınan Kararlar\s*$/m.test(content)
    && /^## Aksiyon Maddeleri\s*$/m.test(content);
}

function markdownBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** Shows the already-authored canonical report; it never starts another model turn. */
export function AutomaticMeetingRecap({ status, reportPath }: { status?: string; reportPath: string }) {
  const terminal = TERMINAL_STATUSES.has((status ?? "").toLowerCase());
  const [state, setState] = useState<RecapState>({ kind: "loading" });

  useEffect(() => {
    if (!terminal || !reportPath) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const load = async (attempt: number): Promise<void> => {
      try {
        const content = await readWorkspaceFile(reportPath);
        if (cancelled) return;
        if (content && isTurkishRecap(content)) {
          setState({ kind: "ready", body: markdownBody(content) });
          return;
        }
      } catch {
        if (cancelled) return;
      }

      if (attempt + 1 >= MAX_ATTEMPTS) {
        setState({ kind: "pending" });
        return;
      }
      retry = setTimeout(() => void load(attempt + 1), retryDelayMs(attempt));
    };

    setState({ kind: "loading" });
    void load(0);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [reportPath, terminal]);

  if (!terminal) return null;

  return (
    <section aria-label="Otomatik toplantı özeti" style={{ marginBottom: 20, padding: 16, border: "1px solid var(--line2)", borderRadius: 10, background: "var(--panel)" }}>
      <div style={{ marginBottom: 10, color: "var(--violet)", fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase" }}>
        Toplantı Özeti
      </div>
      {state.kind === "loading" && <div style={{ color: "var(--t3)", fontSize: 13 }}>Özet hazırlanıyor…</div>}
      {state.kind === "pending" && (
        // NOT an error: the copilot may still be writing. `role="status"` rather than `role="alert"`
        // for the same reason — this is progress information, not a fault.
        <div role="status" style={{ color: "var(--t3)", fontSize: 13, lineHeight: 1.5 }}>
          Özet henüz hazır değil. Uzun toplantılarda hazırlanması birkaç dakika sürebilir —
          sayfayı yenileyerek tekrar bakabilirsiniz.
        </div>
      )}
      {state.kind === "ready" && <MdxDoc style={{ fontSize: 13.5, lineHeight: 1.6 }}>{state.body}</MdxDoc>}
    </section>
  );
}
