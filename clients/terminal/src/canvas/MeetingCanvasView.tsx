"use client";
import { useEffect, useRef, useState } from "react";
import { CanvasActionsProvider, useActions, OPEN_ENTITY_EVENT } from "./actions";
import { MeetingHealthBanner } from "./MeetingHealthBanner";
import { LiveTranscriptEngine, entityKindLabel, signalLabel, type EngineActions, type EngineEntity, type EngineSignal } from "./LiveTranscriptEngine";
import { useMeetingNotes } from "./notes";
import { deriveProcessingView } from "./processingView";
import { MeetingScopeProvider, MeetingSourceProvider, useEntities, useMeeting, useMeetingDocs, useSignals } from "./useMeeting";
import { AutomaticMeetingRecap } from "./AutomaticMeetingRecap";
import { useLiveMeetings } from "../surfaces/liveMeetings";
import "./meetingCanvas.css";

export const MEETING_CANVAS_CONTENT_INSET = 18;

/** ONE render engine for both modes (P23: the terminal RENDERS, it does not re-derive). The toggle picks
 *  the SOURCE — raw segments vs the cleaned processed mirror — not a different renderer. */
function RawTranscript() {
  const { transcript } = useMeeting();
  return <LiveTranscriptEngine segments={transcript.segments} />;
}

// Map a copilot signal's loose context/kind onto the badge taxonomy (decision / action-item /
// question / claim). Unknown kinds fall through as-is so they still render with a neutral hue.
function signalKind(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase();
  if (/decis|commit/.test(k)) return "decision";
  if (/action|task|next.?step|follow/.test(k)) return "action-item";
  if (/question|ask|objection|concern/.test(k)) return "question";
  if (/claim|insight|fact/.test(k)) return "claim";
  return k || "signal";
}

/** PROCESSED v2 = the cleaned mirror with INLINE entity highlights (clickable → research / open entity
 *  doc) and actionable copilot SIGNAL badges, all through the SAME engine. */
function ProcessedTranscript() {
  const notes = useMeetingNotes();
  const entityItems = useEntities();
  const signalItems = useSignals();
  const actions = useActions();

  const segments = notes.map((n) => ({
    speaker: n.speaker, text: n.text, tsMs: n.tsMs, id: n.id, completed: n.completed,
    tags: (n.tags ?? []).map((t) => ({ label: t.label, kind: t.kind })),
  }));

  // Only highlight taggable entities (people/companies/products); numbers/signals aren't worth inline
  // wrapping in flowing prose. `splitTextIntoSpans` re-finds each label so the merge/tail stay intact.
  const entities: EngineEntity[] = entityItems
    .filter((e) => e.kind === "person" || e.kind === "company" || e.kind === "product")
    .map((e) => ({ id: e.id, label: e.name, kind: e.kind, docPath: e.docPath }));

  const signals: EngineSignal[] = signalItems.map((s) => ({ id: s.id, kind: signalKind(s.context), label: s.name }));

  const engineActions: EngineActions = {
    // Research in the VISIBLE chat (so the user sees it), not a hidden fire-and-forget session.
    research: (e) => actions.ask(`"${e.name}" adlı ${entityKindLabel(e.kind)} hakkında web’de ve bilgi grafiğimde araştırma yap. Varlık belgesini yaz ya da güncelle ve commit et, sonra bulduklarını özetle.`),
    // Open the entity's doc — by its path if known, else resolve by name; reveals the center if needed.
    openEntityDoc: (e) => { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_ENTITY_EVENT, { detail: { path: e.docPath, wikilink: e.name } })); },
    onSignal: (sig) => actions.ask(`Bu ${signalLabel(sig.kind)} için görev oluştur ya da doğruluğunu kontrol et: ${sig.label}`),
  };

  return (
    <LiveTranscriptEngine
      segments={segments}
      emptyLabel="Düzeltilmiş transkript henüz hazır değil. Ham metni görüntüleyebilirsiniz."
      entities={entities}
      signals={signals}
      actions={engineActions}
    />
  );
}

function MeetingCanvasBody({ meetingId, initialSection = "summary" }: { meetingId?: string; initialSection?: "summary" | "transcript" }) {
  const { meeting, transcript } = useMeeting();
  const docs = useMeetingDocs();
  const actions = useActions();
  const rows = useLiveMeetings();
  const row = rows.find((m) => m.id === meetingId);
  const owned = !!row && !row.shared;
  const [section, setSection] = useState<"summary" | "transcript" | "notes">(initialSection);
  const live = meeting.live === true;
  const hasNotes = (transcript.notes?.length ?? 0) > 0;
  // Durable truth wins over a stale list `live` flag ([N8] — the row can stay stuck on a live
  // session_uid after a stop): once the effective status is TERMINAL the meeting is not
  // effectively-live, whatever the subscribe key says. THE view-mode rule is the shared
  // deriveProcessingView (processingView.ts) — this component holds no private copy of it.
  const durableTerminal = ["completed", "failed", "stopped", "past"].includes(meeting.status ?? "");
  const effectiveLive = live && !durableTerminal;
  // P0: `meetingId` (the tab id) is the meetings-domain ROW id; the human-readable native is on the
  // meeting state — pass BOTH to /api/meeting/process so it keys the copilot on the row id (leak-safe)
  // while naming the kg doc by the native.
  const nativeId = meeting.nativeId;

  // null = untouched → follow the default (which can flip once the durable notes hydrate).
  const preferenceKey = `vexa.meeting-correction:${meetingId ?? ""}`;
  const [override, setOverride] = useState<boolean | null>(() => {
    try { const saved = sessionStorage.getItem(preferenceKey); return saved === "0" ? false : saved === "1" ? true : null; }
    catch { return null; }
  });
  const [pending, setPending] = useState(false);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const processing = deriveProcessingView({ override, live, hasNotes, durableTerminal });

  // LIVE: the toggle ALSO controls backend processing — ON enables the copilot (full-history backfill
  // the first time, else resume); OFF disables it. COMPLETED: pure view switch — there is nothing to
  // arm any more, so we must NOT hit the process endpoint (a stale-live row counts as completed).
  const toggleProcessing = async () => {
    const next = !processing;
    setProcessingError(null);
    if (meetingId && effectiveLive && owned) {
      setPending(true);
      try {
        const response = await fetch("/api/meeting/process", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ meeting_id: meetingId, native_id: nativeId ?? meetingId, on: next }),
        });
        if (!response.ok) throw new Error("processing preference rejected");
      } catch {
        if (mounted.current) {
          setPending(false);
          setProcessingError("Metin iyileştirme tercihi değiştirilemedi. Lütfen yeniden deneyin.");
        }
        return;
      }
    }
    if (!mounted.current) return;
    setPending(false);
    setOverride(next);
    try { sessionStorage.setItem(preferenceKey, next ? "1" : "0"); } catch { /* preference remains for this view */ }
  };

  // Completed meetings get view names (nothing is "processing" any more); live keeps the arm/disarm wording.
  const label = processing ? "Düzeltilmiş" : "Ham";

  return (
    <div className="meeting-canvas">
      <div role="tablist" aria-label="Toplantı içeriği" className="meeting-canvas-tabs">
        {([ ["summary", "Özet"], ["transcript", "Transkript"], ["notes", "Notlar"] ] as const).map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)}>{text}</button>)}
      </div>
      {section === "transcript" && <>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: `8px ${MEETING_CANVAS_CONTENT_INSET}px 0` }}>
        <button
          type="button"
          onClick={() => void toggleProcessing()}
          disabled={pending}
          aria-pressed={processing}
          title={processing ? "Temizlenmiş asistan görünümü gösteriliyor" : (effectiveLive ? "Ham transkript gösteriliyor — işlemek için açın" : "Ham transkript gösteriliyor")}
          style={{
            display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
            background: processing ? "var(--accent)" : "transparent",
            color: processing ? "var(--on-accent)" : "var(--t2)",
            border: `1px solid ${processing ? "var(--accent)" : "var(--line2)"}`,
            borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 600,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: processing ? "var(--on-accent)" : "var(--t3)", flex: "none" }} />
          {label}
        </button>
        <span style={{ fontSize: 11.5, color: "var(--t3)" }}>{pending ? "Tercih kaydediliyor…" : processing ? "Düzeltilmiş transkript" : "Ham transkript"}</span>
      </div>
      {processingError && <p role="alert" style={{ padding: "8px 18px", color: "var(--danger)", fontSize: 13 }}>{processingError}</p>}
      <MeetingHealthBanner />
      </>}
      <main style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <div style={{ padding: MEETING_CANVAS_CONTENT_INSET }}>
          {section === "summary" && <>
            <AutomaticMeetingRecap status={meeting.status} reportPath={docs.report.path} meetingId={meeting.id} workspace={docs.report.workspace} canEdit={owned} />
            {!durableTerminal && <div className="meeting-canvas-empty"><h2>Görüşme devam ediyor</h2><p>Toplantı özeti görüşme tamamlandığında burada görünür. Konuşmaları Transkript bölümünden takip edebilirsiniz.</p></div>}
          </>}
          {section === "transcript" && (processing ? <ProcessedTranscript /> : <RawTranscript />)}
          {section === "notes" && <section className="meeting-canvas-notes">
            <h2>Hazırlık notları</h2>
            <p>Toplantının gündemini ve hazırlık notlarını buradan açabilir, asistanla birlikte geliştirebilirsiniz.</p>
            {docs.brief.present && <button type="button" onClick={() => actions.openDoc(docs.brief.path, docs.brief.workspace)}>Hazırlık notunu aç</button>}
            <button type="button" onClick={() => actions.ask("Bu toplantının gündemini ve hazırlık notlarını birlikte gözden geçirelim. Mevcut notları oku; değişiklik yapmadan önce önerilerini paylaş.")}>Asistana sor</button>
          </section>}
        </div>
      </main>
    </div>
  );
}

export function MeetingCanvasView({ meetingId, initialSection }: { meetingId?: string; initialSection?: "summary" | "transcript" }) {
  return (
    <MeetingScopeProvider meetingId={meetingId}>
      <MeetingSourceProvider meetingId={meetingId}>
        <CanvasActionsProvider>
          <MeetingCanvasBody key={meetingId} meetingId={meetingId} initialSection={initialSection} />
        </CanvasActionsProvider>
      </MeetingSourceProvider>
    </MeetingScopeProvider>
  );
}
