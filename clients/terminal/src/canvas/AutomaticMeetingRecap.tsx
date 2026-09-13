"use client";

import { useEffect, useRef, useState } from "react";
import { parseReadyReport, readReadyReport, REPORT_TERMINAL_STATUSES, type ReadyReport } from "./reportReadiness";
import { ApiError, presentError, readApiFailure } from "../surfaces/apiClient";
import { MdxDoc } from "../ui-kit/MdxDoc";

/** Poll quickly for short meetings, then allow about twenty minutes for long report turns.
 * An exhausted initial wait remains a recoverable pending state. */
export const RETRY_DELAY_MS = 2000;
export const SLOW_RETRY_DELAY_MS = 10_000;
export const FAST_ATTEMPTS = 30;
export const READY_RECHECK_MS = 15_000;
export const MAX_ATTEMPTS = 144;
export function retryDelayMs(attempt: number): number {
  return attempt < FAST_ATTEMPTS ? RETRY_DELAY_MS : SLOW_RETRY_DELAY_MS;
}

type RecapState =
  | { kind: "loading" }
  | { kind: "ready"; report: ReadyReport }
  | { kind: "pending" }
  | { kind: "unavailable" };
type RecapProps = { status?: string; reportPath: string; meetingId: string; workspace?: string; canEdit?: boolean };
type SummaryDraft = { source: ReadyReport; text: string };

/** Only the text under Özet is editable; decisions and actions remain report content. */
function summarySection(body: string): { text: string; before: string; after: string } | null {
  const headings = [...body.matchAll(/^## Özet[\t ]*\r?$/gm)];
  if (headings.length !== 1) return null;
  const start = headings[0].index! + headings[0][0].length;
  const remaining = body.slice(start);
  const next = remaining.search(/^##[\t ]+/m);
  const end = next < 0 ? body.length : start + next;
  return { text: body.slice(start, end).trim(), before: body.slice(0, start), after: body.slice(end) };
}

/** Reads the canonical report and submits explicit deterministic summary edits. */
export function AutomaticMeetingRecap(props: RecapProps) {
  if (!REPORT_TERMINAL_STATUSES.has((props.status ?? "").toLowerCase())) return null;
  return <RecapContent key={JSON.stringify([props.meetingId, props.workspace, props.reportPath])} {...props} />;
}

function RecapContent({ reportPath, meetingId, workspace, canEdit = false }: RecapProps) {
  const [state, setState] = useState<RecapState>({ kind: "loading" });
  const [draft, setDraft] = useState<SummaryDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!reportPath) return;
    let cancelled = false;
    let observedReport = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number): Promise<void> => {
      const started = generation.current;
      try {
        const report = await readReadyReport({ path: reportPath, meetingId, workspace });
        if (cancelled) return;
        // A read started before a confirmed save cannot replace its committed result.
        if (started !== generation.current) { retry = setTimeout(() => void load(0), READY_RECHECK_MS); return; }
        if (report) {
          observedReport = true;
          setState({ kind: "ready", report });
          retry = setTimeout(() => void load(0), READY_RECHECK_MS);
          return;
        }
      } catch {
        if (cancelled) return;
        if (started !== generation.current) { retry = setTimeout(() => void load(0), READY_RECHECK_MS); return; }
      }
      // Hide cached report and editing content until current authorized access is confirmed.
      if (observedReport) {
        setState({ kind: "unavailable" });
        retry = setTimeout(() => void load(0), READY_RECHECK_MS);
        return;
      }
      if (attempt + 1 >= MAX_ATTEMPTS) { setState({ kind: "pending" }); return; }
      retry = setTimeout(() => void load(attempt + 1), retryDelayMs(attempt));
    };
    setState({ kind: "loading" });
    void load(0);
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, [reportPath, meetingId, workspace]);

  const beginEdit = () => {
    if (!canEdit || state.kind !== "ready") return;
    const summary = summarySection(state.report.body);
    if (!summary) return;
    setDraft({ source: state.report, text: summary.text }); setError(null); setSaved(false);
  };
  const save = async () => {
    if (!canEdit || !draft || pending.current || state.kind !== "ready") return;
    const text = draft.text.trim();
    if (!text || /^ {0,3}#{1,2}(?:[\t ]|$)/m.test(text)) {
      setError("Özet metnini yazın; ana bölüm başlıklarını değiştirmeyin."); return;
    }
    pending.current = true; setSaving(true); setError(null); setSaved(false);
    const source = draft.source;
    try {
      const endpoint = `/api/meeting/${encodeURIComponent(meetingId)}/summary`;
      const response = await fetch(endpoint, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: source.workspace, path: source.path, expected_revision: source.revision, summary: text }),
      });
      if (!response.ok) throw await readApiFailure(response, endpoint);
      const result = await response.json() as { meeting_id?: string | number; workspace?: string; path?: string; revision?: string; content?: string };
      if (!mounted.current) return;
      if (String(result.meeting_id) !== meetingId || result.workspace !== source.workspace || result.path !== source.path || typeof result.content !== "string") {
        throw new Error("Kaydedilen özetin toplantı ve çalışma alanı doğrulaması başarısız oldu.");
      }
      const verified = await parseReadyReport(result.content, { meetingId, workspace: source.workspace, path: source.path });
      if (!mounted.current) return;
      const before = summarySection(source.body);
      const after = verified && summarySection(verified.body);
      if (!verified || result.revision !== verified.revision || !after || after.text !== text
        || before?.before !== after.before || before?.after !== after.after) {
        throw new Error("Kaydedilen özet doğrulanamadı. Taslağınız korunuyor.");
      }
      generation.current += 1;
      setState({ kind: "ready", report: verified }); setDraft(null); setSaved(true);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError && cause.status === 409
        ? "Özet başka bir yerde güncellendi. Taslağınız korundu; güncel sürümü inceleyip yeniden düzenleyin."
        : presentError(cause).headline);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const editing = canEdit && draft !== null && state.kind === "ready";

  return <section aria-label="Otomatik toplantı özeti" style={{ marginBottom: 20, padding: 16, border: "1px solid var(--line2)", borderRadius: 10, background: "var(--panel)" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
      <h2 style={{ margin: 0, color: "var(--violet)", fontSize: 14, fontWeight: 700 }}>Toplantı Özeti</h2>
      {canEdit && !editing && state.kind === "ready" && summarySection(state.report.body) && <button className="text-button" onClick={beginEdit}>Özeti düzenle</button>}
    </div>
    {state.kind === "loading" && <div style={{ color: "var(--t3)", fontSize: 13 }}>Özet hazırlanıyor…</div>}
    {state.kind === "pending" && <div role="status" style={{ color: "var(--t3)", fontSize: 13, lineHeight: 1.5 }}>
      Özet henüz hazır değil. Uzun toplantılarda hazırlanması birkaç dakika sürebilir — sayfayı yenileyerek tekrar bakabilirsiniz.
    </div>}
    {state.kind === "unavailable" && <div role="alert" style={{ color: "var(--danger)", fontSize: 13, lineHeight: 1.5 }}>
      Özete erişim doğrulanamadı. Bağlantınızı ve çalışma alanı erişiminizi kontrol edin.
    </div>}
    {state.kind === "ready" && (editing ? <div>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600 }}>Toplantı özeti
        <textarea value={draft.text} disabled={saving} onChange={(event) => { setDraft({ ...draft, text: event.target.value }); setError(null); }}
          rows={9} autoFocus style={{ display: "block", width: "100%", boxSizing: "border-box", resize: "vertical", marginTop: 8, padding: 12, borderRadius: 8, border: "1px solid var(--line2)", background: "var(--panel)", color: "var(--t1)", font: "inherit", fontWeight: 400, lineHeight: 1.6 }} />
      </label>
      <p style={{ fontSize: 12, color: "var(--t3)" }}>Kararlar ve aksiyon maddeleri korunur.</p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="primary-button" disabled={saving} onClick={() => void save()}>Kaydet</button>
        <button className="secondary-button" disabled={saving} onClick={() => { setDraft(null); setError(null); }}>Vazgeç</button>
        {saving && <span role="status" style={{ fontSize: 12, color: "var(--t3)" }}>Özet kaydediliyor…</span>}
      </div>
    </div> : <MdxDoc style={{ fontSize: 13.5, lineHeight: 1.6 }}>{state.report.body}</MdxDoc>)}
    {error && editing && <p role="alert" style={{ fontSize: 13, color: "var(--danger)" }}>{error}</p>}
    {saved && state.kind === "ready" && !editing && <p role="status" style={{ fontSize: 12, color: "var(--green)" }}>Özet kaydedildi.</p>}
  </section>;
}
