"use client";
import { useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import { useLiveMeetings } from "../surfaces/liveMeetings";
import { readReadyReport, scanReadyReports, type ReadyReport } from "./reportReadiness";

export const REPORT_POLL_MS = 15_000;
const storageKey = (subject: string) => `vexa.report-notifications.v1:${encodeURIComponent(subject)}`;
const reportKey = (report: ReadyReport) => JSON.stringify([report.meetingId, report.workspace, report.path, report.revision]);
type SeenReports = Record<string, boolean>;
function readSeen(subject: string): SeenReports {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(subject)) ?? "{}");
    return Object.fromEntries(Object.entries(value).filter(([, read]) => typeof read === "boolean")) as SeenReports;
  } catch { return {}; }
}
function saveSeen(subject: string, seen: SeenReports) {
  try { localStorage.setItem(storageKey(subject), JSON.stringify(seen)); } catch { /* memory still deduplicates this page */ }
}

export function ReportNotifications({ subject, onOpen }: { subject: string | null; onOpen: (meetingId: string) => void }) {
  if (!subject) return null;
  return <SubjectReportNotifications key={subject} subject={subject} onOpen={onOpen} />;
}

function SubjectReportNotifications({ subject, onOpen }: { subject: string; onOpen: (meetingId: string) => void }) {
  const meetings = useLiveMeetings();
  const [reports, setReports] = useState<ReadyReport[]>([]);
  const [notices, setNotices] = useState<ReadyReport[]>([]);
  const [seen, setSeen] = useState<SeenReports>(() => readSeen(subject));
  const seenRef = useRef(seen);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const aliveRef = useRef(true);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await scanReadyReports(meetings, subject);
        if (!alive) return;
        const known = { ...seenRef.current, ...readSeen(subject) };
        const fresh = next.filter((report) => !Object.hasOwn(known, reportKey(report)));
        for (const report of fresh) known[reportKey(report)] = false;
        seenRef.current = known;
        saveSeen(subject, known);
        setSeen(known);
        setReports(next);
        const authorized = new Set(next.map(reportKey));
        setNotices((current) => [...current.filter((report) => authorized.has(reportKey(report))), ...fresh].slice(-3));
        setError(false);
      } catch (cause) {
        if (!alive) return;
        console.warn("report-notifications: observation failed", cause);
        setReports([]); setNotices([]); setError(true);
      }
      if (alive) timer = setTimeout(() => void poll(), REPORT_POLL_MS);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [meetings, subject]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);

  const visit = async (report: ReadyReport) => {
    try {
      const current = await readReadyReport(report);
      if (!aliveRef.current) return;
      if (!current) throw new Error("report no longer accessible");
      const next = { ...seenRef.current, [reportKey(report)]: true };
      seenRef.current = next; saveSeen(subject, next); setSeen(next);
      setNotices((items) => items.filter((item) => reportKey(item) !== reportKey(report)));
      setOpen(false);
      onOpen(report.meetingId);
    } catch (cause) {
      if (!aliveRef.current) return;
      console.warn("report-notifications: report recheck failed", cause);
      setReports((items) => items.filter((item) => reportKey(item) !== reportKey(report)));
      setNotices((items) => items.filter((item) => reportKey(item) !== reportKey(report)));
      setError(true);
    }
  };
  const unread = reports.filter((report) => seen[reportKey(report)] === false).length;
  return <div ref={host} style={{ position: "relative" }}>
    <button className="icon-button" aria-label="Bildirimler" aria-expanded={open} onClick={() => setOpen(!open)} style={{ position: "relative" }}>
      <Bell size={19} />{unread > 0 && <span aria-label={`${unread} okunmamış bildirim`} style={{ position: "absolute", top: -3, right: -3, background: "var(--accent)", color: "var(--on-accent)", borderRadius: 12, padding: "1px 5px", fontSize: 10 }}>{unread}</span>}
    </button>
    {open && <div role="menu" aria-label="Bildirimler" style={{ position: "absolute", right: 0, top: "calc(100% + 12px)", width: "min(360px, calc(100vw - 32px))", maxHeight: "60vh", overflowY: "auto", borderRadius: 16, padding: 12, background: "var(--panel)", border: "1px solid var(--line)", boxShadow: "0 14px 40px #0002", zIndex: 70 }}>
      <strong style={{ display: "block", padding: 8 }}>Bildirimler</strong>
      {error && <p style={{ padding: 8 }}>Bildirimler şu anda güncellenemiyor.</p>}
      {!error && reports.length === 0 && <p style={{ padding: 8, color: "var(--t3)" }}>Henüz bildirim yok.</p>}
      {reports.map((report) => <button key={reportKey(report)} role="menuitem" onClick={() => void visit(report)} style={{ width: "100%", border: 0, borderRadius: 10, textAlign: "left", padding: 12, color: "var(--t1)", background: seen[reportKey(report)] ? "transparent" : "var(--accentbg)", cursor: "pointer" }}>
        <strong style={{ display: "block", marginBottom: 4 }}>Toplantı özeti hazır</strong><span>{report.title || "Toplantı"}</span>
      </button>)}
    </div>}
    {notices.length > 0 && <div style={{ position: "fixed", right: 20, bottom: 20, width: "min(360px, calc(100vw - 40px))", zIndex: 80, display: "grid", gap: 8, maxHeight: "50dvh", overflowY: "auto" }}>
      {notices.map((report) => <div key={reportKey(report)} role="status" style={{ background: "var(--panel)", color: "var(--t1)", border: "1px solid var(--line)", borderRadius: 14, padding: 16, boxShadow: "0 8px 32px #0002" }}>
        <button className="icon-button" aria-label="Bildirimi kapat" onClick={() => setNotices((items) => items.filter((item) => reportKey(item) !== reportKey(report)))} style={{ float: "right" }}><X size={15} /></button>
        <strong>Toplantı özeti hazır</strong><p style={{ margin: "7px 0" }}>{report.title || "Toplantı"}</p>
        <button className="text-button" onClick={() => void visit(report)}>Özeti aç</button>
      </div>)}
    </div>}
  </div>;
}
