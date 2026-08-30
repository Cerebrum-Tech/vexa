"use client";
/** ISOLATED transcript-pipeline probe. Bypasses the authored canvas view, the mock source, dockview, and
 *  the agent copilot — it subscribes to ONLY the two stores that carry live transcript:
 *    useLiveMeetings()  → resolves the meeting row + its session_uid (the bind)
 *    useMeetingLive()   → the merged SSE feed (transcript + cards + note + connection state)
 *  so we can see, for any live meeting, whether segments are arriving and re-rendering in real time —
 *  independent of everything downstream.  Open /debug/transcript?id=<native_meeting_id>. */
import { useEffect, useRef, useState } from "react";
import { useLiveMeetings } from "../../../surfaces/liveMeetings";
import { useMeetingLive } from "../../../surfaces/meetingLive";

function useQueryId(): string {
  const [id, setId] = useState("");
  useEffect(() => { setId(new URLSearchParams(window.location.search).get("id") ?? ""); }, []);
  return id;
}

function ageLabel(at?: number): string {
  if (!at) return "hiç";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s} sn önce`;
  const m = Math.floor(s / 60);
  return `${m} dk ${s % 60} sn önce`;
}

function hms(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleTimeString()}.${String(at % 1000).padStart(3, "0")}`;
}

/** RAW WIRE — the UNCLEANED truth: a dedicated EventSource that appends EVERY transcript event
 *  exactly as it arrives off the SSE (no upsert-by-id, no note shaping, no copilot).
 *  This is what the bot actually emits — every pending refinement, every re-word — so you can watch
 *  the raw ASR behaviour in real time. Capped to the last 600 events. */
interface RawEvent { at: number; speaker?: string; text?: string; completed?: boolean; id?: string; tsMs?: number }
function useRawWire(meetingId: string, sessionUid: string): RawEvent[] {
  const [events, setEvents] = useState<RawEvent[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !sessionUid || !meetingId) return;
    setEvents([]);
    const es = new EventSource(`/api/meeting/stream?meeting_id=${encodeURIComponent(meetingId)}&session_uid=${encodeURIComponent(sessionUid)}`);
    es.onmessage = (m) => {
      let ev: { type?: string; speaker?: string; text?: string; completed?: boolean; id?: string; tsMs?: number };
      try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type !== "transcript") return;
      setEvents((prev) => {
        const next = [...prev, { at: Date.now(), speaker: ev.speaker, text: ev.text, completed: ev.completed, id: ev.id, tsMs: ev.tsMs }];
        return next.length > 600 ? next.slice(-600) : next;
      });
    };
    return () => es.close();
  }, [meetingId, sessionUid]);
  return events;
}

export default function TranscriptDebug() {
  const requestedId = useQueryId();
  const meetings = useLiveMeetings();
  const row = meetings.find((m) => m.id === requestedId || m.native_id === requestedId);
  const sessionUid = row?.session_uid ?? requestedId;
  const live = useMeetingLive(requestedId || "—", sessionUid);
  const raw = useRawWire(requestedId || "", sessionUid);

  // Render-rate + last-update probe: count renders and stamp when the segment count last changed.
  const renders = useRef(0);
  renders.current += 1;
  const lastCount = useRef(-1);
  const lastChangeAt = useRef<number | null>(null);
  if (live.transcript.length !== lastCount.current) {
    lastCount.current = live.transcript.length;
    lastChangeAt.current = typeof performance !== "undefined" ? Math.round(performance.now()) : null;
  }

  // Everything on this page is live/client-only; render a stable shell on the server to avoid a
  // hydration mismatch on the render counter and connection state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const mono: React.CSSProperties = { fontFamily: "monospace", fontSize: 12 };
  if (!mounted) {
    return <div style={{ padding: 20, ...mono, color: "var(--t3)", background: "var(--bg)", minHeight: "100vh" }} suppressHydrationWarning>sonda yükleniyor…</div>;
  }
  return (
    <div style={{ padding: 20, color: "var(--t1)", background: "var(--bg)", minHeight: "100vh", ...mono }}>
      <h2 style={{ fontSize: 14, marginBottom: 12 }}>Transkript işlem hattı sondası</h2>
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", rowGap: 4, marginBottom: 16 }}>
        <span>istenen id</span><span>{requestedId || "(yok — ?id=… ekleyin)"}</span>
        <span>yüklenen toplantı</span><span>{meetings.length}</span>
        <span>satır çözümlendi</span><span>{row ? `evet — status=${row.live_status ?? row.status}` : "hayır (henüz listede yok)"}</span>
        <span>session_uid</span><span>{sessionUid || "(boş → SSE açılmayacak)"}</span>
        <span>bağlı</span><span style={{ color: live.connected ? "var(--green)" : "var(--danger)" }}>{String(live.connected)}</span>
        <span>sona erdi</span><span>{String(live.ended)}</span>
        <span>yeniden bağlanma</span><span>{live.reconnects}</span>
        <span>son olay</span><span>{ageLabel(live.lastEventAt)}</span>
        <span>son transkript</span><span>{ageLabel(live.lastTranscriptAt)}</span>
        <span>segment</span><span>{live.transcript.length}</span>
        <span>işlenmiş not</span><span>{live.notes.length}</span>
        <span>kart</span><span>{live.cards.length}</span>
        <span>sorun</span><span style={{ color: live.issues.length ? "var(--danger)" : "var(--t3)" }}>{live.issues.length}</span>
        <span>react render</span><span>{renders.current}</span>
        <span>son segment değişimi @</span><span>{lastChangeAt.current == null ? "hiç" : `${lastChangeAt.current}ms`}</span>
      </div>
      {live.issues.length > 0 && (
        <div style={{ borderTop: "1px solid var(--line2)", paddingTop: 10, marginBottom: 14 }}>
          <div style={{ color: "var(--danger)", marginBottom: 6 }}>son sorunlar</div>
          {live.issues.slice(-8).map((issue, i) => (
            <div key={`${issue.at}-${i}`} style={{ marginBottom: 4 }}>
              <span style={{ color: "var(--danger)" }}>{issue.kind}</span>
              <span style={{ color: "var(--t3)" }}> {new Date(issue.at).toLocaleTimeString()} </span>
              <span>{issue.message}{issue.status ? ` (${issue.status})` : ""}</span>
            </div>
          ))}
        </div>
      )}
      {/* RAW WIRE — every event off the SSE, append-only · NO upsert / clustering / copilot */}
      <div style={{ borderTop: "1px solid var(--line2)", paddingTop: 10, marginBottom: 14 }}>
        <div style={{ color: "var(--green)", marginBottom: 6 }}>Ham akış — her olay, temizlenmemiş ({raw.length}) · ~ = beklemede · F = kesin</div>
        {raw.length === 0 && <div style={{ color: "var(--t3)" }}>henüz ham olay yok…</div>}
        {raw.slice(-150).map((ev, i) => (
          <div key={i} style={{ marginBottom: 2, opacity: ev.completed === false ? 0.55 : 1, whiteSpace: "pre-wrap" }}>
            <span style={{ color: "var(--t3)" }}>{hms(ev.at)} </span>
            <span style={{ color: ev.completed === false ? "var(--warn)" : "var(--green)" }}>{ev.completed === false ? "~" : "F"} </span>
            <span style={{ color: "var(--blue)" }}>{ev.speaker} </span>
            <span style={{ color: "var(--t3)" }}>[{ev.id}] </span>
            <span>{ev.text}</span>
          </div>
        ))}
      </div>
      {/* current state per segment_id (upserted — latest text per id, still pre-clustering) */}
      <div style={{ borderTop: "1px solid var(--line2)", paddingTop: 10 }}>
        <div style={{ color: "var(--green)", marginBottom: 6 }}>Ham segmentler — id başına güncel ({live.transcript.length})</div>
        {live.transcript.length === 0 && <div style={{ color: "var(--t3)" }}>henüz segment yok…</div>}
        {live.transcript.slice(-40).map((s, i) => (
          <div key={s.id ?? i} style={{ marginBottom: 6, opacity: s.completed === false ? 0.6 : 1 }}>
            <span style={{ color: "var(--blue)" }}>{s.speaker}</span>
            <span style={{ color: "var(--t3)" }}>{s.completed === false ? " (beklemede)" : ""}</span>
            <div>{s.text}</div>
          </div>
        ))}
      </div>
      {live.note && <div style={{ marginTop: 14, color: "var(--warn)" }}>not: {live.note}</div>}
    </div>
  );
}
