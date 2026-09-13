"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useLiveMeetings } from "../surfaces/liveMeetings";
import { meetingPhase, type MeetingMock } from "../surfaces/meetingModel";

/** A bot that leaves a meeting — stopped from the list, removed by the host, or the meeting ending —
 *  used to change nothing but a badge in a list the user may not be looking at. This watches the live
 *  meetings feed for live → ended transitions and says so, once per meeting, with a way to open it. */
interface Notice { meetingId: string; title: string; failed: boolean }
const NOTICE_TTL_MS = 20_000;

const titleOf = (m: MeetingMock): string => m.title_custom || m.title || m.native_id || "Toplantı";

export function MeetingStatusNotices({ onOpen }: { onOpen: (meetingId: string) => void }) {
  const meetings = useLiveMeetings();
  const [notices, setNotices] = useState<Notice[]>([]);
  const phases = useRef<Map<string, string>>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    const next = new Map<string, string>();
    const ended: Notice[] = [];
    for (const m of meetings) {
      const phase = meetingPhase(m);
      next.set(m.id, phase);
      // Only a transition this page WITNESSED counts: the first snapshot seeds the map silently,
      // so reopening the app after a meeting ended does not replay old departures.
      if (primed.current && phases.current.get(m.id) === "live" && phase === "post") {
        ended.push({ meetingId: m.id, title: titleOf(m), failed: (m.live_status ?? "") === "failed" });
      }
    }
    phases.current = next;
    primed.current = true;
    if (ended.length) setNotices((current) => [...current, ...ended.filter((n) => !current.some((c) => c.meetingId === n.meetingId))].slice(-3));
  }, [meetings]);

  useEffect(() => {
    if (!notices.length) return;
    const timer = setTimeout(() => setNotices((current) => current.slice(1)), NOTICE_TTL_MS);
    return () => clearTimeout(timer);
  }, [notices]);

  if (!notices.length) return null;
  return <div style={{ position: "fixed", right: 20, bottom: 20, width: "min(360px, calc(100vw - 40px))", zIndex: 79, display: "grid", gap: 8 }}>
    {notices.map((n) => <div key={n.meetingId} role="status" style={{ background: "var(--panel)", color: "var(--t1)", border: "1px solid var(--line)", borderRadius: 14, padding: 16, boxShadow: "0 8px 32px #0002" }}>
      <button className="icon-button" aria-label="Bildirimi kapat" onClick={() => setNotices((c) => c.filter((x) => x.meetingId !== n.meetingId))} style={{ float: "right" }}><X size={15} /></button>
      <strong>{n.failed ? "Bot toplantıya katılamadı" : "Bot toplantıdan ayrıldı"}</strong>
      <p style={{ margin: "7px 0" }}>{n.title}</p>
      <p style={{ margin: "0 0 7px", fontSize: 12, color: "var(--t3)" }}>{n.failed ? "Bağlantıyı kontrol edip yeniden gönderebilirsiniz." : "Kayıt durdu; özet hazır olduğunda ayrıca bildirilir."}</p>
      <button className="text-button" onClick={() => { setNotices((c) => c.filter((x) => x.meetingId !== n.meetingId)); onOpen(n.meetingId); }}>Toplantıyı aç</button>
    </div>)}
  </div>;
}
