"use client";

import { useEffect, useState } from "react";
import { readWorkspaceFile } from "../surfaces/workspaceApi";
import { MdxDoc } from "../ui-kit/MdxDoc";

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "past"]);
/** The wait budget for the post-meeting write turn: the report lands minutes after the stop, so the
 *  panel polls the worker's path for ~90s before it declares the report un-authored. */
export const RETRY_DELAY_MS = 2000;
export const MAX_ATTEMPTS = 45;

type RecapState =
  | { kind: "loading" }
  | { kind: "ready"; body: string }
  | { kind: "error" };

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
        setState({ kind: "error" });
        return;
      }
      retry = setTimeout(() => void load(attempt + 1), RETRY_DELAY_MS);
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
      {state.kind === "error" && <div role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>Toplantı özeti oluşturulamadı.</div>}
      {state.kind === "ready" && <MdxDoc style={{ fontSize: 13.5, lineHeight: 1.6 }}>{state.body}</MdxDoc>}
    </section>
  );
}
