"use client";
/** Meetings (mocked backend) — the differentiator flow.
 *  • "meetings" LIST (left): meetings; the live one auto-opens; click any to (re)open its meeting view.
 *  • "meeting" TAB (center): fixed meeting chrome around the Meeting Canvas body.
 *    The generated canvas view consumes this meeting's live MeetingState. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useService } from "../platform";
import { LayoutServiceId, type TabDescriptor } from "../workbench/layout";
import { registerList, registerTab, registerCommand, type TabProps } from "../contributions";
import { Icon } from "../ui-kit";
import { ContextMenu, copyText } from "../ui-kit/ContextMenu";
import { MEETING_CANVAS_CONTENT_INSET, MeetingCanvasView } from "../canvas/MeetingCanvasView";
import { type MeetingMock } from "./meetingModel";
import { ApiError, presentError, readApiFailure } from "./apiClient";
import { resolveJoinError, serviceDenialFromError, type ServiceDenialPresentation } from "./serviceDenial";
import { ServiceDenialPanel } from "./ServiceDenialPanel";
import { useLiveMeetings, useLiveMeetingsConnection, useLiveMeetingsLoaded, liveMeetingsNow, refreshMeetings } from "./liveMeetings";
import { usePreviewPinTab } from "./previewPinTab";
import { defaultBotName } from "./defaultBotName";
import { parseMeetingInput } from "./meetingId";
import { getJitsiHosts } from "./jitsiHosts";
import { mintTranscriptShare, mintInvite, listSharedMemberships, type Membership } from "./workspaceApi";
import { deletePlannedMeeting, MAX_CALENDARS, listCalendars, createCalendar, updateCalendar, syncCalendar, getCalendarSyncStatus, type CalendarConnection, type CalendarSyncStamp } from "./plannedApi";
import { prepTabDescriptor, prepDraftTabDescriptor } from "./meetingPrep";
import { UploadRecordingButton } from "./uploadRecording";

// ── "Oturumu paylaş" — mint a link to this meeting's LIVE FEED (independent transcript share) and,
//    optionally, BUNDLE a shared-workspace invite into the SAME link (?tshare=…&invite=…). The two are
//    decoupled capabilities; this is the one-click way to hand someone both at once. ─────────────────
function platformSlug(display: string): string {
  return display === "Google Meet" ? "google_meet" : display.toLowerCase().replace(/\s+/g, "_");
}
function ShareSessionButton({ platform, native }: { platform: string; native: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("open");
  const [emails, setEmails] = useState("");
  const [ttlDays, setTtlDays] = useState(7);
  const [wsId, setWsId] = useState("");            // "" = transcript only; else also bundle this workspace invite
  const [shares, setShares] = useState<Membership[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    void listSharedMemberships().then((ms) => setShares(ms.filter((m) => m.role === "owner" || m.role === "contributor"))).catch(() => {});
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const allowed = mode === "restricted" ? emails.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : undefined;
      const t = await mintTranscriptShare({ platform, native_meeting_id: native, mode, allowed_emails: allowed, expires_in_sec: ttlDays * 86400 });
      const params = new URLSearchParams();
      params.set("tshare", t.token);
      if (wsId) {  // bundle a workspace membership invite into the same link
        const inv = await mintInvite({ workspace_id: wsId, role: "contributor", mode, expires_in_sec: ttlDays * 86400, max_uses: mode === "open" ? 50 : 1, allowed_emails: allowed });
        params.set("invite", inv.token);
      }
      setLink(`${window.location.origin}/?${params.toString()}`);
    } catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };
  const fieldStyle = { fontSize: 12, padding: "4px 6px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--t1)" } as const;
  return (
    <div ref={ref} style={{ position: "relative", flex: "none" }}>
      <button onClick={() => { setOpen((v) => !v); setLink(null); }} title="Bu toplantının canlı yayınını (ve isterseniz bir çalışma alanını) paylaşın"
        style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", border: "1px solid var(--line2)", color: "var(--t2)", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" }}>
        <Icon name="upload" size={12} /> Oturumu paylaş
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 6, width: 280, background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,.32)", padding: 12, zIndex: 50, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em" }}>Oturumu paylaş</div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value); setLink(null); }} style={{ ...fieldStyle, flex: 1 }}>
              <option value="open">bağlantıya sahip herkes</option>
              <option value="restricted">kısıtlı (e-posta ile)</option>
            </select>
            <select value={ttlDays} disabled={busy} onChange={(e) => { setTtlDays(Number(e.target.value)); setLink(null); }} style={fieldStyle}>
              <option value={1}>1 gün</option><option value={7}>7 gün</option><option value={30}>30 gün</option>
            </select>
          </div>
          {mode === "restricted" && (
            <input value={emails} placeholder="izin verilen e-postalar (virgülle ayrılmış)" disabled={busy}
              onChange={(e) => { setEmails(e.target.value); setLink(null); }} style={fieldStyle} />
          )}
          <select value={wsId} disabled={busy} onChange={(e) => { setWsId(e.target.value); setLink(null); }} style={fieldStyle} title="İsteğe bağlı olarak bağlantıya paylaşılan bir çalışma alanı ekleyin">
            <option value="">yalnızca canlı yayın (çalışma alanı yok)</option>
            {shares.map((s) => <option key={s.workspace_id} value={s.workspace_id}>+ çalışma alanı: {s.workspace_id}</option>)}
          </select>
          {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ {err}</div>}
          {link ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} style={{ ...fieldStyle, flex: 1, fontSize: 11 }} />
              <button onClick={() => void copyText(link)} style={{ fontSize: 12, padding: "4px 10px", background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 6, cursor: "pointer" }}>Kopyala</button>
            </div>
          ) : (
            <button disabled={busy} onClick={() => void create()} style={{ fontSize: 12, padding: "5px 10px", background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 6, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>{busy ? "Oluşturuluyor…" : "Bağlantı oluştur"}</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Connected docs — the meeting's knowledge-graph entity + the [[entities]] it links ─────────────
//  The meeting doc lives at a deterministic path: kg/entities/meeting/<native>.md. When present we show
//  its title + the [[wikilinks]] parsed from the body as chips that open that entity's doc. A wikilink
//  [[Title]] is resolved to a real doc by matching its slug against the workspace tree (so we open the
//  entity under its true type folder, whatever that is). 404 → a quiet "no notes yet" state.
// No client subject: workspace docs are read through the gateway, which injects X-User-Id → agent-api scopes (P20).
const docSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const baseName = (p: string) => p.split("/").pop() ?? p;
const docTabFor = (path: string, title: string): TabDescriptor =>
  ({ id: `doc:${path}`, title, kind: "doc", params: { path } });

type ConnectedDoc = { workspace: string; path: string; title?: string; kind?: string };

function ConnectedDocChip({ doc }: { doc: ConnectedDoc }) {
  const label = doc.title || baseName(doc.path).replace(/\.md$/, "");
  const nav = usePreviewPinTab<HTMLButtonElement>(docTabFor(doc.path, label));
  return (
    <button onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} title={`${doc.path} dosyasını aç`}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--t1)", fontSize: 12.5, cursor: "pointer", maxWidth: 280 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.borderColor = "var(--line2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; e.currentTarget.style.borderColor = "var(--line)"; }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--blue)", flex: "none" }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {doc.kind && <span style={{ fontSize: 9.5, color: "var(--t3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".04em" }}>{doc.kind}</span>}
    </button>
  );
}

function MeetingDocChip({ native, title, hasLinks }: { native: string; title: string; hasLinks: boolean }) {
  const nav = usePreviewPinTab<HTMLButtonElement>(docTabFor(`kg/entities/meeting/${native}.md`, title));
  return (
    <button onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} title="Bu toplantının notlarını aç"
      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px 5px 6px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--t1)", fontSize: 12.5, cursor: "pointer", maxWidth: 360, marginBottom: hasLinks ? 8 : 0 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.borderColor = "var(--line2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; e.currentTarget.style.borderColor = "var(--line)"; }}>
      <span style={{ width: 18, height: 18, flex: "none", borderRadius: 5, background: "var(--accentbg)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="panel" size={11} /></span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
    </button>
  );
}

function WikiLinkChip({ title, path }: { title: string; path: string }) {
  const nav = usePreviewPinTab<HTMLButtonElement>(docTabFor(path, title));
  return (
    <button onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} title={`${title} kaydını aç`}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--t1)", fontSize: 12.5, cursor: "pointer", maxWidth: 280 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.borderColor = "var(--line2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; e.currentTarget.style.borderColor = "var(--line)"; }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--blue)", flex: "none" }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
    </button>
  );
}

// ── Connected (data.docs) — the meeting-api now ships data.docs = the workspace docs this meeting
//  produced. When present we render them as chips grouped by kind, each opening that doc.path in a doc
//  tab. When EMPTY we fall back to the deterministic meeting-doc path below.
function ConnectedDocsPanel({ docs }: { docs: ConnectedDoc[] }) {
  // group by kind, preserving first-seen order
  const groups: { kind: string; docs: ConnectedDoc[] }[] = [];
  const byKind = new Map<string, ConnectedDoc[]>();
  for (const d of docs) {
    const k = d.kind || "doc";
    if (!byKind.has(k)) { byKind.set(k, []); groups.push({ kind: k, docs: byKind.get(k)! }); }
    byKind.get(k)!.push(d);
  }
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px" }}>
        <span style={{ fontSize: 10.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600 }}>Bağlantılı</span>
        <span style={{ fontSize: 10.5, color: "var(--t3)", fontFamily: "var(--mono)" }}>{docs.length}</span>
        <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
      </div>
      {groups.map((g) => (
        <div key={g.kind} style={{ marginBottom: 10 }}>
          {groups.length > 1 && <div style={{ fontSize: 10, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".05em", margin: "0 2px 6px" }}>{g.kind}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{g.docs.map((d, i) => <ConnectedDocChip key={`${d.path}-${i}`} doc={d} />)}</div>
        </div>
      ))}
    </div>
  );
}

function ConnectedPanel({ native, docs }: { native: string; docs?: ConnectedDoc[] }) {
  // data.docs first — when the meeting carries connected docs, render them and skip the path fallback
  const hasDocs = !!docs?.length;
  const [state, setState] = useState<{ status: "loading" | "absent" | "present"; title: string; links: string[] }>({ status: "loading", title: "", links: [] });
  // slug → real entity doc path, built from the workspace tree (so a [[Title]] resolves to its true type)
  const [slugMap, setSlugMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const path = `kg/entities/meeting/${native}.md`;
    void (async () => {
      try {
        const r = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
        if (!alive) return;
        if (!r.ok) { setState({ status: "absent", title: "", links: [] }); return; }
        const content: string = (await r.json()).content ?? "";
        const fmTitle = content.match(/^---\n([\s\S]*?)\n---/)?.[1]?.split("\n").find((l) => l.startsWith("title:"))?.slice(6).trim();
        const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const title = (fmTitle || h1 || native).replace(/^["']|["']$/g, "");
        const links = [...new Set([...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()).filter(Boolean))];
        setState({ status: "present", title, links });
      } catch { if (alive) setState({ status: "absent", title: "", links: [] }); }
    })();
    return () => { alive = false; };
  }, [native]);

  // load the tree once so wikilink slugs resolve to their real entity doc paths
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const files: string[] = (await (await fetch(`/api/workspace/tree`)).json()).files ?? [];
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const f of files) if (f.startsWith("kg/entities/") && f.endsWith(".md")) map[baseName(f).replace(/\.md$/, "")] = f;
        setSlugMap(map);
      } catch { /* offline — keep wikilinks on the meeting doc */ }
    })();
    return () => { alive = false; };
  }, []);

  if (hasDocs) return <ConnectedDocsPanel docs={docs!} />;
  if (state.status === "loading") return null;
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px" }}>
        <span style={{ fontSize: 10.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600 }}>Bağlantılı</span>
        {state.status === "present" && state.links.length > 0 && <span style={{ fontSize: 10.5, color: "var(--t3)", fontFamily: "var(--mono)" }}>{state.links.length}</span>}
        <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
      </div>
      {state.status === "absent" && (
        <div style={{ fontSize: 12.5, color: "var(--t3)", padding: "2px 2px", lineHeight: 1.5 }}>Henüz not yok — bunlar toplantı bittiğinde (veya bir hazırlık rutini çalıştığında) yazılır.</div>
      )}
      {state.status === "present" && (
        <>
          <MeetingDocChip native={native} title={state.title} hasLinks={state.links.length > 0} />
          {state.links.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {state.links.map((l) => {
                const slug = docSlug(l);
                const path = slugMap[slug] ?? `kg/entities/meeting/${native}.md`;
                return <WikiLinkChip key={l} title={l} path={path} />;
              })}
            </div>
          )}
          {state.links.length === 0 && <div style={{ fontSize: 12.5, color: "var(--t3)", padding: "2px 2px" }}>Notlar kaydedildi — henüz bağlantılı varlık yok.</div>}
        </>
      )}
    </div>
  );
}

// ── Per-meeting status badge + action dropdown ─────────────────────────────────────
//  The badge shows the REAL meeting-api status; the dropdown is an ACTION→TRANSITION map (not free
//  status editing) — each item calls ONE endpoint that performs the one legal write (design doc §B).
type BadgeKind = "intent" | "live" | "awaiting" | "needshelp" | "stopping" | "terminal";
const STATUS_BADGE: Record<string, { label: string; color: string; bg: string; kind: BadgeKind }> = {
  idle: { label: "Boşta", color: "var(--t3)", bg: "var(--panel2)", kind: "intent" },
  scheduled: { label: "Zamanlandı", color: "var(--blue)", bg: "var(--bluebg)", kind: "intent" },
  requested: { label: "İstendi", color: "var(--accent)", bg: "var(--accentbg)", kind: "live" },
  joining: { label: "Katılıyor", color: "var(--accent)", bg: "var(--accentbg)", kind: "live" },
  awaiting_admission: { label: "Bekliyor", color: "var(--violet)", bg: "var(--violetbg)", kind: "awaiting" },
  needs_help: { label: "Yardım gerekli", color: "var(--warn)", bg: "var(--warnbg)", kind: "needshelp" },
  active: { label: "Canlı", color: "var(--green)", bg: "var(--greenbg)", kind: "live" },
  stopping: { label: "Durduruluyor", color: "var(--t3)", bg: "var(--panel2)", kind: "stopping" },
  completed: { label: "Tamamlandı", color: "var(--green)", bg: "var(--greenbg)", kind: "terminal" },
  failed: { label: "Başarısız", color: "var(--danger)", bg: "var(--dangerbg)", kind: "terminal" },
  stopped: { label: "Durduruldu", color: "var(--t3)", bg: "var(--panel2)", kind: "terminal" },
};
const badgeFor = (raw?: string) => STATUS_BADGE[raw ?? ""] ?? { label: raw ?? "—", color: "var(--t3)", bg: "var(--panel2)", kind: "terminal" as BadgeKind };

type MeetingActionFailure = {
  actionId: string; actionLabel: string; native: string; message: string;
  /** Set when the service authority REFUSED (403 service_not_allowed / 503 authority-unavailable).
   *  The row renders the panel instead of the one-line message, and does not auto-clear it. */
  denial?: ServiceDenialPresentation | null;
};
type MeetingActionFailureHandler = (failure: MeetingActionFailure) => void;
type RowAction = { id: string; label: string; tone: "accent" | "live" | "muted"; run: (onFailure?: MeetingActionFailureHandler) => Promise<void> | void };

/** A non-ok action response as a STRUCTURED failure (status + backend detail + the intact body),
 *  never a raw string. Shared with `getJson`'s error path so both edges produce the same object. */
const readFailure = (r: Response): Promise<ApiError> => readApiFailure(r);

/** User-truth message for a failed bot/row action (issue #674): a `404` means the backend no
 *  longer has this meeting — the list re-snapshot (runMeetingAction's `finally`) reconciles the
 *  control, so say that; a `409` is the duplicate/already case. Everything else goes through the
 *  presenter seam. Exported (additive) so the action test pins the vocabulary. */
export function presentMeetingActionFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "Bu toplantı artık etkin değil — liste yenileniyor.";
    if (error.status === 409) return "Bu toplantıda zaten bir bot var.";
  }
  // A service-authority refusal (paywall / cap / billing outage) says WHY in its own words —
  // "Anahtarınızın buna erişim yetkisi yok." is a lie about a bot the account simply cannot afford.
  const denial = serviceDenialFromError(error);
  if (denial) return `${denial.title} — ${denial.body}`;
  return presentError(error).headline;
}

async function runMeetingAction(action: Omit<MeetingActionFailure, "message">, request: Promise<Response>, onFailure?: MeetingActionFailureHandler): Promise<void> {
  try {
    const r = await request;
    if (!r.ok) throw await readFailure(r);
  } catch (error) {
    // Operator channel keeps the full plumbing (P18); the UI channel gets the presented truth.
    console.warn("meeting action failed", { ...action, message: String(error instanceof Error ? error.message : error) });
    onFailure?.({ ...action, message: presentMeetingActionFailure(error), denial: serviceDenialFromError(error) });
  } finally {
    refreshMeetings();
  }
}

/** The action→transition map for a row, keyed on its REAL status. Each action hits exactly one endpoint.
 *  Exported (additive — no runtime behavior change) so the behavioral test can assert each status offers
 *  the correct actions and each fires the correct endpoint+body. */
export function actionsFor(m: MeetingMock): RowAction[] {
  const native = m.native_id ?? m.id;
  // The model stores platform DISPLAY-cased ("Google Meet", else the raw API slug like "teams"/"zoom").
  // Stop targets DELETE /bots/{platform}/{native}, so normalise back to the slug — hardcoding google_meet
  // 404s ("No active meeting for this bot") for a live Teams/Zoom bot.
  const platformSlug = m.platform === "Google Meet" ? "google_meet" : m.platform.toLowerCase().replace(/\s+/g, "_");
  const intent = (state: "idle" | "scheduled", at?: string, onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: state === "idle" ? "cancel" : "schedule", actionLabel: state === "idle" ? "İptal" : "Zamanla", native }, fetch(`/api/meetings/${platformSlug}/${encodeURIComponent(native)}/intent`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: state, ...(at ? { at } : {}) }),
    }), onFailure);
  const send = (onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: "send", actionLabel: "Şimdi gönder", native }, fetch("/api/bots", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: platformSlug, native_meeting_id: native,
        // the row's real link when it has one (zoom/teams NEED it); gmeet can be constructed
        ...(m.meeting_url ? { meeting_url: m.meeting_url }
          : platformSlug === "google_meet" ? { meeting_url: `https://meet.google.com/${native}` } : {}),
        bot_name: defaultBotName(),
      }),
    }), onFailure);
  // Delete a PLANNED row — ROW-id addressed (a link-less plan has no platform/native path).
  const del = (onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: "delete", actionLabel: "Sil", native }, fetch(`/api/meetings/${encodeURIComponent(m.id)}`, { method: "DELETE" }), onFailure);
  // Cancel (clear the time) on a LINK-LESS planned row — PATCH by row id (no native path exists).
  const cancelById = (onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: "cancel", actionLabel: "İptal", native }, fetch(`/api/meetings/${encodeURIComponent(m.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheduled_at: null }),
    }), onFailure);
  // Stop = the gateway-backed user-stop route DELETE /bots/{platform}/{native} (meeting-api lifecycle/stop_router).
  const stop = (onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: "stop", actionLabel: "Durdur", native }, fetch(`/api/bots/${platformSlug}/${encodeURIComponent(native)}`, { method: "DELETE" }), onFailure);
  const schedule = (onFailure?: MeetingActionFailureHandler) => {
    // minimal time picker: prompt for a local datetime, send as ISO. (A richer picker can replace this.)
    const def = new Date(Date.now() + 3600_000).toISOString().slice(0, 16);
    const input = typeof window !== "undefined" ? window.prompt("Zamanlanacak tarih ve saat (YYYY-MM-DD HH:MM, yerel):", def) : null;
    if (!input) return;
    const at = new Date(input).toISOString();
    return intent("scheduled", at, onFailure);
  };

  const raw = m.live_status ?? (m.status === "live" ? "active" : "completed");
  const hasLink = !!m.native_id;
  switch (raw) {
    case "idle":
      return [
        ...(hasLink ? [
          { id: "schedule", label: "Zamanla", tone: "accent", run: schedule } as RowAction,
          { id: "send", label: "Şimdi gönder", tone: "accent", run: send } as RowAction,
        ] : []),
        { id: "delete", label: "Sil", tone: "muted", run: del },
      ];
    case "scheduled":
      return [
        ...(hasLink ? [{ id: "send", label: "Şimdi gönder", tone: "accent", run: send } as RowAction] : []),
        { id: "cancel", label: "İptal", tone: "muted", run: (onFailure?: MeetingActionFailureHandler) => hasLink ? intent("idle", undefined, onFailure) : cancelById(onFailure) },
        { id: "delete", label: "Sil", tone: "muted", run: del },
      ];
    case "requested": case "joining": case "awaiting_admission": case "needs_help": case "active": case "stopping":
      return [{ id: "stop", label: "Durdur", tone: "live", run: stop }];
    case "completed": case "failed": case "stopped": default:
      return [{ id: "resend", label: "Yeniden gönder", tone: "accent", run: send }];
  }
}

function StatusBadge({ raw }: { raw?: string }) {
  const b = badgeFor(raw);
  const dot = b.kind === "live" || b.kind === "needshelp";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 7px", borderRadius: 5, background: b.bg, color: b.color, fontSize: 10, fontWeight: 600, letterSpacing: ".02em", whiteSpace: "nowrap", flex: "none" }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: b.color }} />}{b.label}
    </span>
  );
}

/** Status badge (only when meaningful) + a small ▾ menu of action→transition items for one meeting row.
 *  The ▾ is revealed on row hover (or while its menu is open) to keep the list quiet at rest. */
function RowActions({ m, showBadge, reveal, onActionStart, onActionFailure }: { m: MeetingMock; showBadge: boolean; reveal: boolean; onActionStart?: () => void; onActionFailure?: MeetingActionFailureHandler }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const acts = actionsFor(m);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", flex: "none", display: "inline-flex", alignItems: "center", gap: 5 }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {showBadge && <StatusBadge raw={m.live_status} />}
      {acts.length > 0 && (reveal || open) && (
        <button title="İşlemler" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          style={{ background: "transparent", border: "1px solid var(--line2)", color: "var(--t2)", borderRadius: 6, padding: "1px 5px", fontSize: 11, lineHeight: 1.4, cursor: "pointer" }}>▾</button>
      )}
      {open && (
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, minWidth: 132, background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,.28)", padding: 4, zIndex: 40 }}>
          {acts.map((a) => (
            <button key={a.id} onClick={(e) => { e.stopPropagation(); setOpen(false); onActionStart?.(); void a.run(onActionFailure); }}
              style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: a.tone === "live" ? "var(--danger)" : a.tone === "muted" ? "var(--t2)" : "var(--accent)", borderRadius: 6, padding: "6px 9px", fontSize: 12, fontWeight: 550, cursor: "pointer" }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--panel2)")} onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const INTENT_STATUSES = new Set(["idle", "scheduled"]);

export function meetingTab(m: MeetingMock): TabDescriptor {
  // A PLANNED (intent-status) row opens its PREP tab — title/time/link editing, workspace bind,
  // share. Once the bot claims the row (requested→…), the same row opens the live meeting view.
  if (INTENT_STATUSES.has(m.live_status ?? "")) return prepTabDescriptor({ id: m.id, title: m.title_custom || m.title });
  return { id: `meeting:${m.id}`, title: m.title.split(" — ")[0], kind: "meeting", params: { meetingId: m.id } };
}

// Statuses worth a badge — `active` (in-room) is shown by the green dot alone, not a badge; the rest
// (stopped/completed/failed) live under the "Recorded" header already.
const BADGE_STATUSES = new Set(["idle", "scheduled", "requested", "joining", "awaiting_admission", "needs_help", "stopping"]);

function MeetingRow({ m }: { m: MeetingMock }) {
  const nav = usePreviewPinTab<HTMLDivElement>(meetingTab(m));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState(false);
  const [actionFailure, setActionFailure] = useState<MeetingActionFailure | null>(null);
  const native = m.native_id ?? m.id;
  const live = m.status === "live";
  const inRoom = m.live_status === "active";   // actually live = green dot + a quiet "live", no badge
  // A planned meeting's user-given title wins; else just the meeting code — the platform is implicit.
  const label = m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "");
  const showBadge = BADGE_STATUSES.has(m.live_status ?? "");
  const isIntent = INTENT_STATUSES.has(m.live_status ?? "");
  useEffect(() => {
    if (!actionFailure) return;
    // A service denial is a thing the user must ACT on (add funds, finish setup, raise the cap) —
    // it must not evaporate on a 6s timer the way a transient "already has a bot" should.
    if (actionFailure.denial) return;
    const t = window.setTimeout(() => setActionFailure(null), 6000);
    return () => window.clearTimeout(t);
  }, [actionFailure]);
  return (
    <div onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }} style={{ padding: "7px 9px", borderRadius: 7, cursor: "pointer", marginBottom: 1 }}
      onMouseEnter={(e) => { setHover(true); e.currentTarget.style.background = "var(--panel2)"; }} onMouseLeave={(e) => { setHover(false); e.currentTarget.style.background = "transparent"; }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {inRoom && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flex: "none" }} />}
        <span style={{ fontSize: 13, color: live ? "var(--t1)" : "var(--t2)", fontWeight: live ? 600 : 400, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {m.shared && <span title="Sizinle paylaşıldı (bu toplantının sahibi değilsiniz)" style={{ flex: "none", fontSize: 9.5, color: "var(--t3)", border: "1px solid var(--line)", borderRadius: 5, padding: "0 5px" }}>paylaşılan</span>}
        {(m.native_id || isIntent) && !m.shared && <RowActions m={m} showBadge={showBadge} reveal={hover} onActionStart={() => setActionFailure(null)} onActionFailure={setActionFailure} />}
      </div>
      <div style={{ fontSize: 11, color: inRoom ? "var(--green)" : "var(--t3)", marginTop: 1, paddingLeft: inRoom ? 13 : 0 }}>{inRoom ? "canlı" : m.when}</div>
      {isIntent && m.auto_join_error && (
        <div role="alert" style={{ fontSize: 11, color: "var(--danger)", marginTop: 3, lineHeight: 1.35 }}>
          ⚠ Otomatik katılım başarısız oldu: {m.auto_join_error}
        </div>
      )}
      {actionFailure?.denial ? (
        <div onClick={(e) => e.stopPropagation()}>
          <ServiceDenialPanel presentation={actionFailure.denial} />
        </div>
      ) : actionFailure && (
        <div role="status" aria-live="polite" style={{ fontSize: 11, color: "var(--danger)", marginTop: 4, lineHeight: 1.35 }}>
          {actionFailure.actionLabel} işlemi başarısız oldu: {actionFailure.message}
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { id: "copy-reference", label: "Referansı kopyala", detail: `@meeting:${native}`, onSelect: () => copyText(`@meeting:${native}`) },
        ]} />
      )}
    </div>
  );
}

// ── "+ Toplantı planla" — opens a DRAFT prep tab. No backend row is created here; the prep tab
//    creates the row lazily on the first real input (title/link/date, brief chat, …), so abandoning
//    the tab never leaves an empty "Başlıksız toplantı" behind. ─────────────────────────────────────
function PlanMeetingButton() {
  const layout = useService(LayoutServiceId);
  return (
    <button onClick={() => layout.openTab(prepDraftTabDescriptor())}
      style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "1px dashed var(--line2)", color: "var(--t2)", borderRadius: 7, padding: "6px 9px", fontSize: 12, cursor: "pointer", marginBottom: 2 }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel2)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      + Toplantı planla
    </button>
  );
}

/** The last sync attempt, humanized: "✓ 2 dk önce eşitlendi — 3 içe aktarıldı, 1 güncellendi" or the actual error. */
function CalendarSyncStatusLine({ stamp }: { stamp: CalendarSyncStamp | null }) {
  if (!stamp?.last_sync) return null;
  const ago = (() => {
    const s = Math.max(0, (Date.now() - new Date(stamp.last_sync).getTime()) / 1000);
    if (s < 90) return "az önce";
    if (s < 3600) return `${Math.round(s / 60)} dk önce`;
    return `${Math.round(s / 3600)} sa önce`;
  })();
  if (stamp.last_error) {
    return <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", lineHeight: 1.5 }}>⚠ Son eşitleme başarısız oldu ({ago}): {stamp.last_error}</div>;
  }
  const c = stamp.counts ?? {};
  const bits = [c.created ? `${c.created} içe aktarıldı` : "", c.updated ? `${c.updated} güncellendi` : "", c.cancelled ? `${c.cancelled} kaldırıldı` : ""].filter(Boolean);
  return (
    <div style={{ fontSize: 11.5, color: "var(--green)", lineHeight: 1.5 }}>
      ✓ {ago} eşitlendi{bits.length ? ` — ${bits.join(", ")}` : " — katılınabilir bağlantısı olan toplantı bulunamadı"}
    </div>
  );
}

// ── Calendar sync — the QUICK view over the user's calendar CONNECTIONS (#1150 plural API).
//    Per-calendar auto-join + Sync now live here because they are the two things you reach for
//    mid-day; adding, renaming, replacing a feed and disconnecting live in Settings → Calendar
//    (one manager, not two — the design-spec's "same list twice" anti-pattern). The feed address
//    is write-only: it is typed once here for the FIRST calendar and never rendered back.
//    Two skins over ONE popover: `icon` (the quiet header icon, always there) and `row` (a
//    discoverable "Takviminizi bağlayın" row that hides itself once a calendar exists). ──
function CalendarSyncButton({ variant = "icon" }: { variant?: "icon" | "row" }) {
  const layout = useService(LayoutServiceId);
  const [open, setOpen] = useState(false);
  const [cals, setCals] = useState<CalendarConnection[] | null>(null);
  const [stamps, setStamps] = useState<Record<string, CalendarSyncStamp>>({});
  const [url, setUrl] = useState("");
  const [name, setName] = useState("Takvimim");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async (withStamps: boolean) => {
    try {
      const list = await listCalendars();
      setCals(list);
      if (!withStamps) return;
      const pairs = await Promise.all(list.map(async (c) => {
        try { return [c.id, await getCalendarSyncStatus(c.id)] as const; }
        catch { return [c.id, {} as CalendarSyncStamp] as const; }
      }));
      setStamps(Object.fromEntries(pairs));
    } catch { setCals(null); }
  }, []);

  const syncOne = async (id: string) => {
    setSyncing(id); setErr(null);
    try { const st = await syncCalendar(id); setStamps((s) => ({ ...s, [id]: st })); refreshMeetings(); }
    catch (e) { setErr(presentError(e).headline); }
    finally { setSyncing(null); }
  };

  // the row skin needs the connected-state up front (it hides once a calendar exists)
  useEffect(() => {
    if (variant !== "row") return;
    void load(false);
  }, [variant, load]);
  useEffect(() => {
    if (!open) return;
    void load(true);
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, load]);

  const setAutoJoin = async (cal: CalendarConnection, autoJoin: boolean) => {
    setBusy(true); setErr(null);
    try {
      await updateCalendar(cal.id, { auto_join: autoJoin });
      await load(false);
      await syncOne(cal.id);   // PATCH does not reconcile already-imported meetings; the sync does
    }
    catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const connectFirst = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true); setErr(null);
    try {
      const created = await createCalendar({ name: name.trim() || "Takvimim", ics_url: u, auto_join: true });
      setUrl(""); refreshMeetings();
      await load(false);
      await syncOne(created.id);            // paste → an ANSWER, not a silent wait
    }
    catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const connected = (cals?.length ?? 0) > 0;
  const openSettings = () => { setOpen(false); layout.openTab({ id: "settings", title: "Ayarlar", kind: "settings", params: {} }); };

  if (variant === "row" && connected) return null;   // has one → manage via the header icon / Settings
  return (
    <div ref={ref} style={{ position: "relative", flex: variant === "row" ? "initial" : "none" }}>
      {variant === "row" ? (
        <button onClick={() => setOpen((v) => !v)}
          style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "1px dashed var(--line2)", color: "var(--t2)", borderRadius: 7, padding: "6px 9px", fontSize: 12, cursor: "pointer", marginTop: 6 }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel2)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
          <Icon name="cal" size={12} /> Takviminizi bağlayın
        </button>
      ) : (
        <button onClick={() => setOpen((v) => !v)} title="Takvimler — yaklaşan toplantıları takvimlerinizden içe aktarın"
          style={{ display: "inline-flex", alignItems: "center", background: "transparent", border: "none", color: connected ? "var(--accent)" : "var(--t3)", cursor: "pointer", padding: 2 }}>
          <Icon name="cal" size={13} />
        </button>
      )}
      {open && (
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 6, width: 300, background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,.32)", padding: 12, zIndex: 50, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em" }}>
            {connected ? `takvimler · ${cals?.length ?? 0} / ${MAX_CALENDARS}` : "takvim eşitleme"}
          </div>
          {connected ? (
            <>
              {cals?.map((c) => (
                <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 5, borderBottom: "1px dashed var(--line)", paddingBottom: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ flex: 1, fontSize: 12, color: c.enabled ? "var(--t1)" : "var(--t3)", fontWeight: 600 }}>{c.name}</span>
                    {!c.enabled && <span style={{ fontSize: 10.5, color: "var(--t3)" }}>duraklatıldı</span>}
                    <button disabled={busy || syncing !== null} onClick={() => void syncOne(c.id)}
                      style={{ fontSize: 11.5, padding: "3px 8px", background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--t1)", borderRadius: 6, cursor: "pointer" }}>
                      {syncing === c.id ? "Eşitleniyor…" : "Eşitle"}
                    </button>
                  </div>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "var(--t2)", cursor: "pointer", userSelect: "none" }}>
                    <input type="checkbox" checked={c.auto_join} disabled={busy || syncing !== null}
                      onChange={(e) => void setAutoJoin(c, e.target.checked)} />
                    Bu takvimdeki toplantılara otomatik katıl
                  </label>
                  <CalendarSyncStatusLine stamp={stamps[c.id] ?? null} />
                </div>
              ))}
              <button onClick={openSettings}
                style={{ fontSize: 11.5, padding: "4px 10px", background: "transparent", border: "1px solid var(--line2)", color: "var(--t2)", borderRadius: 6, cursor: "pointer" }}>
                Ayarlar → Takvim bölümünden ekleyin, yeniden adlandırın veya bağlantıyı kesin
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5 }}>
                Takviminizin <b>gizli ICS adresini</b> yapıştırın (Google Calendar → Ayarlar → &ldquo;iCal biçiminde gizli adres&rdquo;).
                Meet/Zoom/Teams bağlantısı olan yaklaşan toplantılar Yaklaşan bölümünde görünür ve başlangıçta otomatik katılır.
              </div>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={100}
                aria-label="Takvim adı" placeholder="Takvim adı"
                style={{ fontSize: 11.5, padding: "5px 7px", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--t1)", outline: "none" }} />
              <input value={url} placeholder="https://calendar.google.com/…/basic.ics" disabled={busy}
                type="password" autoComplete="off" aria-label="Gizli ICS adresi"
                onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void connectFirst(); }}
                style={{ fontSize: 11.5, padding: "5px 7px", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--t1)", outline: "none" }} />
              <button disabled={busy || !url.trim()} onClick={() => void connectFirst()}
                style={{ fontSize: 12, padding: "5px 10px", background: url.trim() ? "var(--accent)" : "var(--panel2)", color: url.trim() ? "var(--bg)" : "var(--t3)", border: "none", borderRadius: 6, cursor: url.trim() ? "pointer" : "default" }}>
                {busy || syncing !== null ? "Bağlanıyor…" : "Bağlan"}
              </button>
              <div style={{ fontSize: 10.5, color: "var(--t3)", lineHeight: 1.45 }}>
                İpucu: <i>herkese açık</i> adres yalnızca herkese açık yaptığınız etkinlikleri taşır — takviminizin tamamı için <b>gizli</b> adresi kullanın.
              </div>
            </>
          )}
          {err && <div role="alert" style={{ fontSize: 11, color: "var(--danger)" }}>⚠ {err}</div>}
        </div>
      )}
    </div>
  );
}

// ── Meetings LIST (left) ─────────────────────────────────────────────────────────
function MeetingsList() {
  const layout = useService(LayoutServiceId);
  // The meeting LIST lives on the Today page (the center) — the sidebar never renders it too
  // (design-spec §v4 anti-pattern: same list twice). The rail keeps only its ACTIONS + a link to Today.
  const all = useLiveMeetings();                                   // real meetings (live + past) from agent-api
  const autoOpened = useRef(false);
  useEffect(() => {                                                // a live meeting opens itself, once
    const firstLive = all.find((m) => m.status === "live");
    if (!autoOpened.current && firstLive) {
      autoOpened.current = true;
      layout.openTab(meetingTab(firstLive));
    }
  }, [all, layout]);
  // 'add bot from URL': send OUR bot into a meeting; the watcher attaches the copilot once it transcribes
  const [url, setUrl] = useState("");
  const [sent, setSent] = useState<null | "sending" | "ok" | "err">(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [denial, setDenial] = useState<ServiceDenialPresentation | null>(null);
  const addBot = async () => {
    const u = url.trim();
    if (!u || sent === "sending") return;
    // Parse + validate the pasted link/id against the platform formats (mirrors join-form).
    const parsed = parseMeetingInput(u, await getJitsiHosts());
    if (!parsed) { setSent("err"); setErrMsg("Bu bir Meet / Zoom / Teams / Jitsi bağlantısına benzemiyor."); setDenial(null); setTimeout(() => setSent(null), 5000); return; }
    setSent("sending"); setErrMsg(null); setDenial(null);
    let refused = false;
    try {
      // POST /bots through the authed gateway proxy (X-API-Key injected server-side from the cookie token).
      const r = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: parsed.platform, native_meeting_id: parsed.native_meeting_id, meeting_url: u, bot_name: defaultBotName() }),
      });
      if (r.ok) {
        setSent("ok"); setUrl("");
        // The list has no background poll, so force a re-fetch now and again as the bot
        // transitions requested → joining → active (else the meeting only shows on reload).
        refreshMeetings(); setTimeout(refreshMeetings, 2000); setTimeout(refreshMeetings, 6000);
      } else {
        // Surface the REAL reason, not a generic "bad link" (the cap/dup/auth cases are common).
        setSent("err");
        if (r.status === 429) { setErrMsg("Toplantı sınırınıza ulaştınız — önce birini durdurun."); }
        else if (r.status === 409) { setErrMsg("Bu toplantıda zaten bir bot var."); }
        else if (r.status === 401) { setErrMsg("Giriş yapılmadı — giriş yapıp yeniden deneyin."); }
        else {
          // 403 service_not_allowed / 503 service_authority_unavailable are the service authority
          // refusing, not an access fault: they get their own words and their own fix.
          const state = resolveJoinError(await readFailure(r));
          if (state.kind === "denial") { setDenial(state.presentation); setErrMsg(null); refused = true; }
          else setErrMsg(state.headline);
        }
      }
    } catch { setSent("err"); setErrMsg("Sunucuya ulaşılamadı."); }
    // The transient flash clears itself; a denial panel is sticky until the next attempt — a
    // paywall the user has to act on must not vanish on a 5s timer.
    if (!refused) setTimeout(() => setSent(null), 5000);
  };
  return (
    <div style={{ padding: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "6px 4px 6px" }}>
        <span style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em", flex: 1 }}>toplantılar</span>
        <CalendarSyncButton />
      </div>
      <div style={{ padding: "0 4px 10px" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addBot(); }}
            placeholder="Toplantı bağlantısını yapıştırın (Meet / Zoom / Teams / Jitsi)…" style={{ flex: 1, minWidth: 0, background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 7, padding: "6px 8px", color: "var(--t1)", fontSize: 12, outline: "none" }} />
          <button onClick={() => void addBot()} disabled={!url.trim() || sent === "sending"} title="Innova Toplantı Asistanı botunu bu toplantıya gönder"
            style={{ flex: "none", background: url.trim() ? "var(--accent)" : "var(--panel2)", color: url.trim() ? "var(--on-accent)" : "var(--t3)", border: "none", borderRadius: 7, padding: "0 10px", fontSize: 12, fontWeight: 600, cursor: url.trim() ? "pointer" : "default" }}>
            {sent === "sending" ? "…" : "Bot gönder"}
          </button>
        </div>
        {sent === "ok" && <div style={{ fontSize: 11, color: "var(--green)", marginTop: 5, lineHeight: 1.4 }}>Bot gönderildi — toplantıda kabul edin; transkripsiyona başladığında burada görünür.</div>}
        {denial
          ? <ServiceDenialPanel presentation={denial} onRetry={() => void addBot()} />
          : sent === "err" && <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 5, lineHeight: 1.4 }}>{errMsg ?? "Gönderilemedi."}</div>}
        <div style={{ marginTop: 8 }}>
          <PlanMeetingButton />
          {/* No bot was sent to this one: a recording that already exists becomes a meeting the
              same way — same transcript, same list row, same post-meeting report. */}
          <UploadRecordingButton />
          <CalendarSyncButton variant="row" />
        </div>
      </div>
      {/* The day itself renders in the center (Today) — the sidebar only links there. */}
      <button onClick={() => layout.openTab({ id: "today", title: "Bugün", kind: "today", params: {} })}
        style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "10px 9px", fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, cursor: "pointer" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--t2)")} onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}>
        {all.length === 0 ? "Henüz toplantı yok — yukarıya bir bağlantı yapıştırın veya Bugün sayfasını açın →" : "Toplantılarınız Bugün sayfasında →"}
      </button>
    </div>
  );
}

// ── Meeting COPILOT tab (center) — meeting shell + canvas ──────────────────────────
type ModelInfo = { chat_model?: string; streaming_model?: string; agent_model?: string; meeting_model?: string };

function useModelInfo(): ModelInfo | null {
  const [models, setModels] = useState<ModelInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/models`, { cache: "no-store" });
        if (!alive || !r.ok) return;
        setModels(await r.json() as ModelInfo);
      } catch {
        /* model labels are informational */
      }
    })();
    return () => { alive = false; };
  }, []);
  return models;
}

function ModelChips() {
  const models = useModelInfo();
  const streaming = models?.streaming_model || models?.meeting_model || "varsayılan";
  const chat = models?.chat_model || models?.agent_model || "varsayılan";
  const chip = (label: string, value: string) => (
    <span title={`${label} modeli: ${value}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 7, color: "var(--t2)", background: "var(--panel)", fontSize: 11.5, whiteSpace: "nowrap", minWidth: 0 }}>
      <span style={{ color: "var(--t3)", fontFamily: "var(--mono)", flex: "none" }}>{label}</span>
      <span style={{ color: "var(--t1)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{value}</span>
    </span>
  );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", justifyContent: "flex-end", minWidth: 0 }}>
      {chip("akış", streaming)}
      {chip("sohbet", chat)}
    </div>
  );
}

/** Bot lifecycle controls on the meeting page header (owner ask 2026-07-09): Stop while the bot
 *  is in the call, Re-send once it stopped/completed/failed. Reuses the row-action map verbatim
 *  (same endpoints, same status vocabulary) — only bot actions surface here; row management
 *  (schedule/cancel/delete) stays in the sidebar menu. */
export function BotControls({ m, connected = true }: { m: MeetingMock; connected?: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acts = actionsFor(m).filter((a) => a.id === "stop" || a.id === "resend" || a.id === "send");
  if (acts.length === 0) return null;
  // The control's enabled-ness is a pure function of (row status, WS-connected): while the live
  // `meeting.status` stream is down the row may be a stale snapshot, so a state-bearing control
  // degrades to indeterminate/disabled — never an actionable stop control for a meeting the backend
  // may no longer have (issue #674).
  const disabled = busy || !connected;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
      {acts.map((a) => {
        const danger = a.tone === "live";
        return (
          <button key={a.id} disabled={disabled}
      title={!connected ? "Canlı bağlantı kesildi — yeniden bağlanıyor…" : undefined}
            onClick={() => {
              if (disabled) return;
              setErr(null); setBusy(true);
              void Promise.resolve(a.run((f) => setErr(f.message))).finally(() => setBusy(false));
            }}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent",
              border: `1px solid ${danger ? "var(--danger)" : "var(--line2)"}`,
              color: danger ? "var(--danger)" : "var(--accent)",
              borderRadius: 7, padding: "4px 11px", fontSize: 12, fontWeight: 600,
              cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}>
            {a.id === "stop" ? "Botu durdur" : "Botu yeniden gönder"}
          </button>
        );
      })}
      {err && <span role="alert" style={{ fontSize: 11, color: "var(--danger)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={err}>⚠ {err}</span>}
    </span>
  );
}

/** Header state as a pure function of (row, WS-connected) — the badge and the bot controls both
 *  derive from it, so a stale-live snapshot can never present as Live while the authoritative
 *  `meeting.status` stream is down (issue #674). Exported for the behavioral test. */
export function meetingHeaderState(m: MeetingMock | undefined, connected: boolean): "live" | "reconnecting" | "recap" | "connecting" {
  if (!m) return "connecting";
  if (m.status !== "live") return "recap";
  return connected ? "live" : "reconnecting";
}

/** Whether a requested meeting id has RESOLVED, is still resolving, or does not exist for this user.
 *  `listLoaded` is the meetings list having answered at least once — without it an id that simply hasn't
 *  been fetched yet is indistinguishable from one that doesn't exist, and an addressable URL
 *  (`/meetings/<id>`) would show a permanent "Connecting…" for a deleted or foreign meeting.
 *  Exported for the routing test. */
export type MeetingResolution = "resolving" | "resolved" | "not-found";
export function meetingResolution(m: MeetingMock | undefined, listLoaded: boolean): MeetingResolution {
  if (m) return "resolved";
  return listLoaded ? "not-found" : "resolving";
}

/** The clean terminal state for an id that isn't ours (deleted, mistyped, someone else's un-shared
 *  meeting). A dead reference is a normal outcome of a shareable URL, so it reads as an answer — not an
 *  error, not a spinner that never ends. Pure (no services) so it renders in a test as-is. */
export function MeetingNotFound({ meetingId, onOpenToday }: { meetingId: string; onOpenToday?: () => void }) {
  return (
    <div role="status" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 380, textAlign: "center" }}>
        <div style={{ fontSize: 15, color: "var(--t1)", fontWeight: 550, marginBottom: 6 }}>Toplantı bulunamadı</div>
        <div style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.55 }}>
          {meetingId
            ? <>Burada <span style={{ fontFamily: "var(--mono)", color: "var(--t2)" }}>{meetingId}</span> ile eşleşen bir kayıt yok. Silinmiş olabilir ya da sizinle paylaşmamış birine ait olabilir.</>
            : <>Bu bağlantı bir toplantı taşımıyor. Gününüzden bir toplantı açın.</>}
        </div>
        {onOpenToday && (
          <button onClick={onOpenToday}
            style={{ marginTop: 16, fontSize: 12.5, padding: "5px 12px", background: "transparent", border: "1px solid var(--line2)", color: "var(--t2)", borderRadius: 7, cursor: "pointer" }}>
            Bugün&rsquo;ü aç
          </button>
        )}
      </div>
    </div>
  );
}

function MeetingTab({ params }: TabProps) {
  const layout = useService(LayoutServiceId);
  const liveList = useLiveMeetings();
  const listLoaded = useLiveMeetingsLoaded();
  const connected = useLiveMeetingsConnection();
  const requestedMeetingId = params.meetingId as string;
  // ONE resolver, shared with the canvas body (useMeeting.resolveMeeting): the real meetings list is the
  // only source of truth — a mock never shadows a real id, and a real id never falls back to a mock. While
  // the async list is still loading the row is simply not-yet-resolved; we render the canvas bound to the
  // id with a neutral header (never a wrong/mock meeting), so the header can't disagree with the body.
  const m = liveList.find((x) => x.id === requestedMeetingId || x.native_id === requestedMeetingId);
  const header = meetingHeaderState(m, connected);

  // An unknown id — a stale/foreign/mistyped meeting URL — is a clean dead end, never a crash and never
  // an endless "Connecting…". Only once the list has actually answered (P0: an offline list keeps
  // resolving, so a network blip can't make a live meeting look deleted).
  if (meetingResolution(m, listLoaded) === "not-found") {
    return (
      <MeetingNotFound
        meetingId={requestedMeetingId}
        onOpenToday={() => layout.openTab({ id: "today", title: "Bugün", kind: "today", params: {} })}
      />
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", padding: "16px 0 24px", boxSizing: "border-box" }}>
      <header style={{ flex: "none", marginBottom: 16, padding: `0 ${MEETING_CANVAS_CONTENT_INSET}px`, boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
            {header === "live"
              ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--green)", fontWeight: 600, letterSpacing: ".04em", fontSize: 11, textTransform: "uppercase", flex: "none" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)", boxShadow: "0 0 0 3px var(--greenbg)" }} />Canlı</span>
              : header === "reconnecting"
                ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent)", fontWeight: 600, letterSpacing: ".04em", fontSize: 11, textTransform: "uppercase", flex: "none" }} title="Canlı bağlantı kesildi — son bilinen durum güncel olmayabilir"><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 3px var(--accentbg)" }} />Yeniden bağlanıyor…</span>
                : header === "recap"
                  ? <span style={{ display: "inline-flex", alignItems: "center", color: "var(--violet)", background: "var(--violetbg)", fontWeight: 600, letterSpacing: ".06em", fontSize: 10.5, textTransform: "uppercase", borderRadius: 999, padding: "2px 9px", flex: "none" }}>Toplantı özeti</span>
                  : <span style={{ fontSize: 11, color: "var(--t3)", fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", flex: "none" }}>Bağlanıyor…</span>}
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--t3)", flex: "none" }} />
            <span style={{ color: "var(--t1)", fontWeight: 550, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m ? (m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "")) : "Toplantı"}</span>
            {m && <span style={{ color: "var(--t3)", flex: "none", fontSize: 12 }}>{m.platform}</span>}
            {m && <span style={{ color: "var(--t3)", flex: "none" }}>{m.participants.length} katılımcı</span>}
          </div>
          <div style={{ flex: 1 }} />
          {m && <BotControls m={m} connected={connected} />}
          {m?.native_id && <ShareSessionButton platform={platformSlug(m.platform)} native={m.native_id} />}
          <ModelChips />
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MeetingCanvasView key={requestedMeetingId} meetingId={requestedMeetingId} />
      </div>
    </div>
  );
}

registerList({ id: "meetings", label: "Toplantılar", icon: "cal", order: 20, component: MeetingsList,
  // clicking Meetings opens the user's DAY in the center (design-spec meeting-lifecycle-v2, W2)
  centerTab: { id: "today", title: "Bugün", kind: "today", params: {} } });
registerTab("meeting", MeetingTab);
registerCommand({ id: "meeting.openLive", title: "Canlı toplantıyı aç", run: ({ container }) => { const m = liveMeetingsNow()[0]; if (m) container.get(LayoutServiceId).openTab(meetingTab(m)); } });
