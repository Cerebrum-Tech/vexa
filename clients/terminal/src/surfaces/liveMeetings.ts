"use client";
/** meetings feed — the terminal's REAL meetings list (live AND past), sourced from meeting-api via the
 *  gateway: `GET /api/meetings` → gateway → meeting-api `GET /meetings`. Each row is shaped
 *  {id, platform, native_meeting_id, status, start_time, end_time, data:{recordings:[...]}}, newest-first.
 *  Live meetings carry a `session_uid` so the tab subscribes to the copilot stream; past meetings open a
 *  recorded view whose transcript is fetched on demand from `GET /api/transcripts/{platform}/{native}`. */
import { useSyncExternalStore } from "react";
import type { MeetingMock, TranscriptLine } from "./meetingModel";
import { meetingTimestamp } from "./meetingGroups";
import { onGatewayWSConnected, onMeetingStatus } from "./gatewayWS";

/** A row from meeting-api GET /meetings (live AND past). */
interface MeetingRowDTO {
  id: number | string;
  platform: string;
  native_meeting_id: string | null;   // null on a link-less PLANNED meeting (platform 'unknown')
  status: string;
  shared?: boolean;   // surfaced via a share/membership (not owned by the caller)
  created_at?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  constructed_meeting_url?: string | null;
  data?: {
    recordings?: unknown[];
    docs?: { workspace: string; path: string; title?: string; kind?: string }[];
    scheduled_at?: string;
    stop_requested?: boolean;
    // planned-meeting keys (POST /meetings / calendar sync)
    title?: string;
    workspace_id?: string;
    calendar_uid?: string;
    auto_join?: boolean;
    auto_join_error?: string;
    constructed_meeting_url?: string;
    attendees?: { email: string; name?: string; partstat?: string }[];
  } | null;
}

/** `stopped` is not a DB enum value — it's derived from a terminal `completed` row that the user stopped
 *  (data.stop_requested, per the design doc §A). Resolve the display status from the raw row. */
function displayStatus(d: MeetingRowDTO): string {
  if (d.status === "completed" && d.data?.stop_requested) return "stopped";
  return d.status;
}

/** A transcript segment from meeting-api GET /transcripts/{platform}/{native}. */
interface SegmentDTO {
  segment_id?: string | null;
  start?: number | null;
  speaker?: string | null;
  text?: string | null;
}

/** A persisted processed note from the durable store (`data.processed.views[].doc.notes[]`,
 *  written by meeting-api's db-writer from the copilot's proc stream). SAME producer and shape as
 *  the live SSE `note` event payload — {id, speaker, chapter, text, t?, pass, frozen}. */
export interface ProcessedNoteDTO {
  id: string;
  speaker?: string;
  chapter?: string;
  text: string;
  t?: number;
  tsMs?: number;   // absent in the durable store (live-only anchor); optional so the merged union renders
  pass?: number;
  frozen?: boolean;
}

/** The copilot view id inside data.processed.views[] (mirrors meeting-api's PROC_VIEW_ID). */
const COPILOT_NOTES_VIEW_ID = "copilot-notes";

interface ProcessedViewDTO { id?: string; doc?: { notes?: unknown[] } | null }
interface TranscriptResponseDTO {
  segments?: SegmentDTO[];
  data?: { processed?: { views?: ProcessedViewDTO[] } | null } | null;
}

/** Both durable halves of a meeting's transcript response: the raw segments (mapped for the
 *  transcript pane) and the copilot's persisted processed notes. */
export interface DurableTranscript {
  lines: TranscriptLine[];
  notes: ProcessedNoteDTO[];
}

/** Pull the copilot-notes view's notes out of a transcript response body. Exported for tests. */
export function processedNotesOf(body: TranscriptResponseDTO | null | undefined): ProcessedNoteDTO[] {
  const views = body?.data?.processed?.views;
  if (!Array.isArray(views)) return [];
  const view = views.find((v) => v?.id === COPILOT_NOTES_VIEW_ID);
  const raw = view?.doc?.notes;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
    .map((n) => ({
      id: String(n.id ?? "").trim(),
      speaker: typeof n.speaker === "string" ? n.speaker : undefined,
      chapter: typeof n.chapter === "string" ? n.chapter : undefined,
      text: typeof n.text === "string" ? n.text : "",
      t: typeof n.t === "number" && Number.isFinite(n.t) ? n.t : undefined,
      pass: typeof n.pass === "number" ? n.pass : undefined,
      frozen: typeof n.frozen === "boolean" ? n.frozen : undefined,
    }))
    .filter((n) => n.id && n.text.trim());
}

/** Merge live note deltas OVER a durable seed by note id (the backend's own merge rule — a live
 *  re-emit of a persisted note updates it in place, never duplicates). Seed order is preserved;
 *  notes only seen live append in arrival order. Exported for tests. */
export function mergeNotesById<T extends { id: string }>(seed: T[], live: T[]): T[] {
  if (!seed.length) return live;
  if (!live.length) return seed;
  const seedIds = new Set(seed.map((n) => n.id));
  const liveById = new Map(live.map((n) => [n.id, n]));
  const out: T[] = seed.map((n) => liveById.get(n.id) ?? n);
  for (const n of live) if (!seedIds.has(n.id)) out.push(n);
  return out;
}

function formatTranscriptTime(start?: number | null): string {
  if (start == null || !Number.isFinite(start)) return "";
  const date = new Date(start * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// Statuses where the bot is in/heading-to the room — these map to the list's "live" bucket and carry a
// session_uid so the tab subscribes to the copilot stream. awaiting_admission/needs_help are live too.
const LIVE_STATUSES = new Set(["active", "joining", "requested", "awaiting_admission", "needs_help", "stopping"]);

let meetings: MeetingMock[] = [];
let loadError: string | null = null;
let loaded = false;        // a snapshot has come back at least once — an id absent from the list is then
                           // genuinely unknown (not merely not-fetched-yet), which is what lets a meeting
                           // route render a not-found state instead of a forever-"Connecting…" shell.
let wsConnected = false;   // the live meeting.status stream's connection state — part of the store's external state
const subs = new Set<() => void>();
let started = false;
let wsUnsub: (() => void) | null = null;
let connUnsub: (() => void) | null = null;
let storeRevision = 0;

/** The UI locale. Every date this surface prints is Turkish — Intl otherwise follows the
 *  BROWSER's locale, which would put English month names on rows in a Turkish list. */
const LOCALE = "tr-TR";

function whenLabel(d: MeetingRowDTO, live: boolean): string {
  const at = meetingTimestamp({ live_status: d.status, scheduled_at: d.data?.scheduled_at,
    start_time: d.start_time ?? undefined, created_at: d.created_at ?? undefined, end_time: d.end_time ?? undefined });
  if (!at) return "Tarih bilgisi alınamadı";
  const label = new Date(at).toLocaleString(LOCALE, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return live ? `${label} · canlı` : label;
}

function toMock(d: MeetingRowDTO): MeetingMock {
  const raw = displayStatus(d);
  const live = LIVE_STATUSES.has(d.status);
  const native = d.native_meeting_id;
  // P0 (cross-tenant leak + wrong-row hydration fix): the tab identity + the live SUBSCRIBE key is the
  // meetings-domain ROW id (`d.id`), NOT the native code. The native id is NOT unique — it collides
  // across a user's re-sends of the same link (distinct rows) and across DIFFERENT tenants. Keying the
  // tab/subscribe by the row id makes every row a DISTINCT meeting: it subscribes to its OWN row-keyed
  // transcript stream (`tc:meeting:{id}`) and its OWN copilot out-stream (`agent-meet-{id}`), and fetches
  // its OWN durable transcript by id. The native id rides on `native_id` for DISPLAY + bot actions
  // (send/stop target the native), and the readable meeting-doc name.
  const id = String(d.id);
  return {
    id,
    native_id: native ?? undefined,
    session_uid: live ? id : undefined,  // only live meetings subscribe to the copilot stream — by ROW id
    // a planned meeting's user-given title wins; otherwise the platform·native fallback
    // Honest fallbacks (design-spec W3): a link-less plan is "Untitled meeting", never
    // "unknown · (no link)"; a linked one reads "Google Meet · abc-defg-hij".
    title: d.data?.title
      || (native ? `${d.platform === "google_meet" ? "Google Meet" : d.platform} · ${native}` : "Başlıksız toplantı"),
    title_custom: d.data?.title ?? undefined,
    when: whenLabel(d, live),
    status: live ? "live" : "past",
    live_status: raw,
    shared: !!d.shared,   // owned by someone else, surfaced via a share/membership (data.shared)
    scheduled_at: d.data?.scheduled_at ?? undefined,
    workspace_id: d.data?.workspace_id ?? undefined,
    calendar_uid: d.data?.calendar_uid ?? undefined,
    attendees: d.data?.attendees ?? undefined,
    auto_join: d.data?.auto_join,
    auto_join_error: d.data?.auto_join_error ?? undefined,
    meeting_url: d.constructed_meeting_url ?? d.data?.constructed_meeting_url ?? undefined,
    created_at: d.created_at ?? undefined,
    start_time: d.start_time ?? undefined,
    end_time: d.end_time ?? undefined,
    platform: d.platform === "google_meet" ? "Google Meet" : d.platform,
    has_recording: Array.isArray(d.data?.recordings) ? d.data.recordings.length > 0 : undefined,
    docs: d.data?.docs ?? [],
    participants: (d.data?.attendees ?? []).map((a) => ({ name: a.name || a.email, role: "", initials: (a.name || a.email).slice(0, 2).toLocaleUpperCase("tr-TR") })),
    mentioned: [],
    actions: [],
    transcript: [],
    insights: [],
  };
}

/** Load the complete authorized list. Pages are staged together so a failed later page cannot
 * publish a partial library. Cached content is retired when its authorization is revalidated. */
async function snapshot() {
  const revision = ++storeRevision;
  meetings = [];
  loaded = false;
  loadError = null;
  subs.forEach((f) => f());
  try {
    const pageSize = 100;
    const rows = new Map<string, MeetingMock>();
    for (let offset = 0; ; offset += pageSize) {
      const r = await fetch(`/api/meetings?limit=${pageSize}&offset=${offset}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Toplantılar yüklenemedi. Erişiminizi kontrol edip yeniden deneyin.");
      const body = await r.json() as { meetings?: MeetingRowDTO[] };
      if (revision !== storeRevision) return;
      if (!Array.isArray(body.meetings)) throw new Error("Toplantı listesi okunamadı. Yeniden deneyin.");
      let added = 0;
      for (const row of body.meetings) {
        const id = String(row.id);
        if (!rows.has(id)) { rows.set(id, toMock(row)); added++; }
      }
      if (body.meetings.length < pageSize) break;
      if (!added) throw new Error("Toplantı listesinin devamı yüklenemedi. Yeniden deneyin.");
    }
    if (revision !== storeRevision) return;
    meetings = [...rows.values()];
    loaded = true;
    subs.forEach((f) => f());
  } catch (error) {
    if (revision !== storeRevision) return;
    meetings = [];
    loaded = true;
    loadError = error instanceof Error ? error.message : "Toplantılar yüklenemedi. Yeniden deneyin.";
    subs.forEach((f) => f());
  }
}

/** Apply a `meeting.status` WS frame to the store: patch the matching row's status in place (the snapshot
 *  already seeded the row metadata). Match by native, falling back to meeting_id. Unknown rows trigger a
 *  re-snapshot so a freshly-created (scheduled/idle) meeting surfaces. */
function applyFrame(f: { meeting_id?: number | string; native?: string; status: string; when?: string }) {
  storeRevision += 1;
  // P0: match the ROW id first (`meeting_id`) — a native-only match would patch EVERY row sharing that
  // native (several distinct meetings), flipping the wrong rows' status. Fall back to native only when
  // the frame carries no row id (older producer), accepting that ambiguity for that legacy frame shape.
  const i = meetings.findIndex(
    (m) => (f.meeting_id != null && m.id === String(f.meeting_id)) || (f.native != null && f.meeting_id == null && m.native_id === f.native),
  );
  if (i < 0) { void snapshot(); return; }
  // a DELETED row (calendar sync retiring a planned meeting) leaves the store — patching it in
  // place would make a cancelled future meeting masquerade as "Kayıt alındı" until the next snapshot
  if (f.status === "deleted") {
    meetings = [...meetings.slice(0, i), ...meetings.slice(i + 1)];
    subs.forEach((fn) => fn());
    return;
  }
  const live = LIVE_STATUSES.has(f.status);
  const cur = meetings[i];
  const nextRow: MeetingMock = {
    ...cur,
    live_status: f.status,
    status: live ? "live" : "past",
    session_uid: live ? cur.id : undefined,  // subscribe by the ROW id (P0)
    scheduled_at: f.status === "scheduled" ? (f.when ?? cur.scheduled_at) : cur.scheduled_at,
  };
  nextRow.when = whenLabel({ id: nextRow.id, platform: nextRow.platform, native_meeting_id: nextRow.native_id ?? null,
    status: f.status, start_time: nextRow.start_time, created_at: nextRow.created_at, end_time: nextRow.end_time,
    data: { scheduled_at: nextRow.scheduled_at } }, live);
  meetings = [...meetings.slice(0, i), nextRow, ...meetings.slice(i + 1)];
  subs.forEach((fn) => fn());
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  void snapshot();                          // initial snapshot on mount
  wsUnsub = onMeetingStatus(applyFrame);    // then live status deltas over the gateway WS
  connUnsub = onGatewayWSConnected((ok) => {
    // Propagate connected-ness into the store's external state: consumers (the meeting header's
    // bot controls) must know when the rows are a possibly-stale snapshot rather than live truth
    // (issue #674) — a disconnected store never silently serves stale rows as current.
    if (wsConnected !== ok) {
      wsConnected = ok;
      subs.forEach((f) => f());
    }
    if (ok) void snapshot();
  });
}

const EMPTY_DURABLE: DurableTranscript = { lines: [], notes: [] };

/** Fetch a meeting's DURABLE transcript over REST (gateway → meeting-api): the recorded segments
 *  for the transcript pane PLUS the copilot's persisted processed notes (data.processed.views —
 *  the copilot-notes view). For a past meeting this is THE source; for a live one it seeds
 *  whatever was persisted before the client connected. Returns empties on error.
 *
 *  P0 (wrong-row hydration fix): fetch by the meetings-domain ROW id via
 *  `GET /api/transcripts/by-id/{meetingId}` (owner-scoped downstream). The native path
 *  (`/transcripts/{platform}/{native}`) resolves to the NEWEST row for that native, so a user with
 *  several rows on the same link always read the latest — the notes of an OLDER row vanished. Fetching
 *  by the exact row id returns THAT row's segments + processed notes, never a sibling's (and never
 *  another tenant's). `meetingId` is the row id the mock now carries as `id`. */
export async function fetchDurableTranscript(meetingId: string): Promise<DurableTranscript> {
  try {
    const r = await fetch(`/api/transcripts/by-id/${encodeURIComponent(meetingId)}`, { cache: "no-store" });
    if (!r.ok) return EMPTY_DURABLE;
    const body = (await r.json()) as TranscriptResponseDTO;
    const list = body.segments || [];
    const lines = list
      .filter((s) => (s.text ?? "").trim())
      .map((s) => ({ ...(s.segment_id ? { id: s.segment_id } : {}), t: formatTranscriptTime(s.start), speaker: s.speaker || "Konuşmacı", text: s.text ?? "" }));
    return { lines, notes: processedNotesOf(body) };
  } catch {
    return EMPTY_DURABLE;
  }
}

/** Fetch a PAST meeting's recorded transcript lines (segments only), by the ROW id. Kept for callers
 *  that don't need the processed notes. */
export async function fetchTranscript(meetingId: string): Promise<TranscriptLine[]> {
  return (await fetchDurableTranscript(meetingId)).lines;
}

/** Last-known meeting by id (sync) — lets non-hook lookups resolve a real meeting. */
export function getLiveMeeting(id: string): MeetingMock | undefined {
  return meetings.find((m) => m.id === id);
}

/** All last-known real meetings (sync) — used by the auto-open command (prefers a live one). */
export function liveMeetingsNow(): MeetingMock[] {
  return meetings;
}

/** Force a one-shot snapshot re-fetch — call after a dropdown action (schedule/cancel/send/stop) so the
 *  list reflects the new status immediately, even before the echoing WS frame lands. */
export function refreshMeetings(): void {
  void snapshot();
}

/** Subscribe a component to the live `meeting.status` stream's CONNECTION state. `false` means the
 *  rows are the last snapshot, not live truth — state-bearing controls (Stop bot …) must degrade
 *  to indeterminate/disabled until it is `true` again (ws.v1 is the authoritative state channel). */
export function useLiveMeetingsConnection(): boolean {
  ensureStarted();
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => wsConnected,
    () => false,
  );
}

/** Subscribe a component to whether the meetings list has ANSWERED at least once. `false` means "still
 *  resolving"; `true` means the list is authoritative, so an id missing from it does not exist for this
 *  user (deleted, never existed, or owned by someone else and not shared). */
export function useLiveMeetingsLoaded(): boolean {
  ensureStarted();
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => loaded,
    () => false,
  );
}

/** Subscribe a component to the meetings feed (live + past). */
export function useLiveMeetings(): MeetingMock[] {
  ensureStarted();
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => meetings,
    () => meetings,
  );
}

/** A failed list is distinct from an empty authorized library. */
export function useLiveMeetingsError(): string | null {
  ensureStarted();
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => loadError,
    () => null,
  );
}
