"use client";
/** The complete authorized meeting library, organized by each canonical run. */
import { useState } from "react";
import { registerTab } from "../contributions";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import type { MeetingMock } from "./meetingModel";
import { useLiveMeetings, useLiveMeetingsLoaded, useLiveMeetingsError, useLiveMeetingsConnection, refreshMeetings } from "./liveMeetings";
import { filterMeetingLibrary, meetingTimestamp, type LibraryView, type LibraryOwnership, type MeetingGroup } from "./meetingGroups";
import { meetingTab, RowActions } from "./meeting";
import { MeetingsOnboarding, JoinMeetingForm } from "./meetingsOnboarding";
import { prepDraftTabDescriptor } from "./meetingPrep";
import { UploadRecordingButton } from "./uploadRecording";
import "./meetingLibrary.css";

// ── reviewed-recaps store (localStorage) — opening a recap retires its phrase ──────────────────
const REVIEWED_KEY = "vexa.reviewedMeetings";
let reviewed: Set<string> = new Set();
try { reviewed = new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "[]") as string[]); } catch { /* fresh */ }
const reviewedSubs = new Set<() => void>();
let reviewedSnapshot: string[] = [...reviewed];
export function markReviewed(runId: string): void {
  if (reviewed.has(runId)) return;
  reviewed.add(runId);
  reviewedSnapshot = [...reviewed];
  try { localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewedSnapshot.slice(-500))); } catch { /* quota */ }
  reviewedSubs.forEach((f) => f());
}
// ── pure timeline splitters (unit-tested offline) ─────────────────────────────────────────────
export interface AgendaDay { key: string; date: Date; groups: MeetingGroup[] }

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** The agenda window: day-grouped upcoming (+live) meetings for the week starting at
 *  today + 7·weekOffset days. Unscheduled plans attach to TODAY (offset 0 only) — they need
 *  attention but have no place on a time axis. Days without events are omitted, except today. */
export function agendaWindow(groups: MeetingGroup[], now: Date = new Date(), weekOffset = 0): AgendaDay[] {
  const start = startOfDay(now);
  start.setDate(start.getDate() + weekOffset * 7);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const days = new Map<string, AgendaDay>();
  const put = (d: Date, g: MeetingGroup) => {
    const k = dayKey(d);
    let day = days.get(k);
    if (!day) { day = { key: k, date: startOfDay(d), groups: [] }; days.set(k, day); }
    day.groups.push(g);
  };
  for (const g of groups) {
    if (g.phase !== "prep" && g.phase !== "live") continue;
    const at = g.current.scheduled_at ? new Date(g.current.scheduled_at) : null;
    if (at && Number.isFinite(at.getTime())) {
      // a live meeting always shows — clamp a stale/past schedule onto today so it can't vanish
      const slot = g.phase === "live" && at < start ? new Date(now) : at;
      if (slot >= start && slot < end) put(slot, g);
    } else if (weekOffset === 0) {
      put(new Date(now), g);   // unscheduled (or undated live) → today's row, "no time set"
    }
  }
  // today's row always renders on the current week so "No events today" is stated honestly
  if (weekOffset === 0 && !days.has(dayKey(now))) days.set(dayKey(now), { key: dayKey(now), date: startOfDay(now), groups: [] });
  const out = [...days.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const day of out) {
    day.groups.sort((a, b) => (a.current.scheduled_at ?? "9999").localeCompare(b.current.scheduled_at ?? "9999"));
  }
  return out;
}

export interface PastEntry { run: MeetingMock; group: MeetingGroup }
export interface PastDay { key: string; date: Date; entries: PastEntry[] }

const PAST_CAP = Number.POSITIVE_INFINITY;

/** Finished runs remain individually accessible, newest first. */
export function pastFeed(groups: MeetingGroup[], cap: number = PAST_CAP): PastDay[] {
  const entries: PastEntry[] = groups
    .flatMap((g) => g.pastRuns.map((run) => ({ run, group: g })))
    .sort((a, b) => (b.run.start_time ?? "").localeCompare(a.run.start_time ?? ""))
    .slice(0, cap);
  const days = new Map<string, PastDay>();
  for (const e of entries) {
    const d = e.run.start_time ? new Date(e.run.start_time) : new Date();
    const k = dayKey(d);
    let day = days.get(k);
    if (!day) { day = { key: k, date: startOfDay(d), entries: [] }; days.set(k, day); }
    day.entries.push(e);
  }
  return [...days.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** ONE deviation phrase per row (the rendering law) — or null for the quiet default.
 *  `hasOwnBrief`: an unbound meeting whose brief lives as this meeting's note in the user's OWN
 *  workspace (frame-6 flow) is PREPARED — quiet, same as a bound workspace. */
export function deviationPhrase(g: MeetingGroup, hasOwnBrief = false): { text: string; tone: "live" | "danger" | "accent" } | null {
  const m = g.current;
  if (g.phase === "live") return { text: "toplantıda →", tone: "live" };
  if (m.auto_join_error) return { text: "içe aktarılamadı — toplantı bağlantısı yok", tone: "danger" };
  if (!m.native_id && !m.meeting_url) return { text: "toplantı bağlantısı yok", tone: "danger" };
  if (!m.workspace_id && !hasOwnBrief) return { text: "hazırlık notu yok", tone: "accent" };
  return null;
}


function LibraryRow({ m, connected }: { m: MeetingMock; connected: boolean }) {
  const layout = useService(LayoutServiceId);
  const [failure, setFailure] = useState<string | null>(null);
  const stamp = meetingTimestamp(m);
  const date = stamp ? new Date(stamp) : null;
  const title = m.title_custom || m.title;
  const open = () => { markReviewed(m.id); layout.openTab(meetingTab(m)); };
  return <li className="meeting-library-row">
    <button type="button" className="meeting-library-open" onClick={open}>
      <span className={`meeting-library-symbol ${m.status === "live" ? "is-live" : ""}`} aria-hidden="true">{m.status === "live" ? "●" : "▤"}</span>
      <span className="meeting-library-description">
        <strong>{title}</strong>
        <span>{m.platform === "teams" ? "Microsoft Teams" : m.platform} · {date ? date.toLocaleString("tr-TR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Tarih bilgisi alınamadı"}</span>
        {!!m.attendees?.length && <span className="meeting-library-attendees">{m.attendees.slice(0, 3).map((a) => a.name || a.email).join(", ")}{m.attendees.length > 3 ? ` +${m.attendees.length - 3}` : ""}</span>}
      </span>
      <span className="meeting-library-ownership">{m.shared ? "Benimle paylaşılan" : "Benim toplantım"}</span>
    </button>
    <div className="meeting-library-actions">
      {!m.shared && (m.status !== "live" || connected) && <RowActions m={m} showBadge reveal onActionStart={() => setFailure(null)} onActionFailure={(f) => setFailure(f.message)} />}
      <button type="button" onClick={open} aria-label={`${title} ayrıntıları`}>Aç →</button>
    </div>
    {failure && <p role="alert" className="meeting-library-failure">{failure}</p>}
  </li>;
}

export function TodayView() {
  const meetings = useLiveMeetings();
  const loaded = useLiveMeetingsLoaded();
  const error = useLiveMeetingsError();
  const connected = useLiveMeetingsConnection();
  const layout = useService(LayoutServiceId);
  const [view, setView] = useState<LibraryView>("past");
  const [search, setSearch] = useState("");
  const [ownership, setOwnership] = useState<LibraryOwnership>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const rows = filterMeetingLibrary(meetings, { view, search, ownership, from, to });
  const live = filterMeetingLibrary(meetings, { view: "live" });
  return <section className="meeting-library" aria-label="Toplantılar">
    <header className="meeting-library-header">
      <div><p className="meeting-library-eyebrow">TOPLANTI ÇALIŞMA ALANINIZ</p><h1>Toplantılar</h1><p>Görüşmeleriniz, kararlarınız ve bir sonraki adımınız.</p></div>
      <div className="meeting-library-actions">
        <UploadRecordingButton onOpen={(id) => layout.openTab({ id: `meeting:${id}`, title: "Kayıt transkripti", kind: "meeting", params: { meetingId: String(id), initialSection: "transcript" } })} />
        <button className="meeting-library-refresh" onClick={() => layout.openTab(prepDraftTabDescriptor())}>+ Toplantı planla</button>
      </div>
    </header>
    <section className="meeting-quick-join" aria-label="Hızlı katılım">
      <h2>Canlı toplantıya katıl</h2>
      <p>Bağlantıyı yapıştırın, asistan hemen katılıp toplantıyı yazıya döksün.</p>
      <JoinMeetingForm prominent onJoined={(id) => layout.openTab({ id: `meeting:${id}`, title: "Canlı toplantı", kind: "meeting", params: { meetingId: id } })} />
    </section>
    {loaded && !error && live.length > 0 && view !== "live" && <section className="meeting-library-live" aria-label="Devam eden toplantılar">
      <h2><span aria-hidden="true">●</span> Devam eden toplantılar</h2>
      {live.map((meeting) => <button key={meeting.id} type="button" onClick={() => layout.openTab(meetingTab(meeting))} aria-label={`Canlı toplantıyı aç: ${meeting.title_custom || meeting.title}`}>
        <strong>{meeting.title_custom || meeting.title}</strong><span>Canlı toplantıyı aç →</span>
      </button>)}
    </section>}
    <div className="meeting-library-toolbar">
      <div role="tablist" aria-label="Toplantı zamanı" className="meeting-library-tabs">
        {([ ["past", "Geçmiş"], ["upcoming", "Yaklaşan"], ["live", "Canlı"] ] as const).map(([id, text]) => <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}>{text}<span>{filterMeetingLibrary(meetings, { view: id }).length}</span></button>)}
      </div>
      <button className="meeting-library-refresh" onClick={refreshMeetings}>Yenile</button>
    </div>
    <div className="meeting-library-filters">
      <label className="meeting-library-search"><span>Toplantı ara</span><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Toplantı adı veya katılımcı…" /></label>
      <label><span>Sahiplik</span><select value={ownership} onChange={(e) => setOwnership(e.target.value as LibraryOwnership)}><option value="all">Tümü</option><option value="mine">Benim</option><option value="shared">Benimle paylaşılan</option></select></label>
      <label><span>Başlangıç tarihi</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label><span>Bitiş tarihi</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </div>
    {!loaded ? <p role="status" className="meeting-library-empty">Toplantılar yükleniyor…</p>
      : error ? <p role="alert" className="meeting-library-empty">{error}</p>
      : meetings.length === 0 ? <MeetingsOnboarding variant="full" showJoin={false} />
      : <><p className="meeting-library-count" role="status">{rows.length} toplantı</p>
        {rows.length ? <ul className="meeting-library-list">{rows.map((m) => <LibraryRow key={m.id} m={m} connected={connected} />)}</ul>
          : <div className="meeting-library-empty"><h2>Bu görünümde toplantı yok</h2><p>Başka bir tarih veya arama deneyebilirsiniz.</p></div>}
        {view === "upcoming" && <MeetingsOnboarding variant="slim" showJoin={false} />}
      </>}
  </section>;
}
registerTab("today", TodayView);
