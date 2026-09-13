"use client";
/** Meeting preparation keeps all parameters local until an explicit Planla or Katıl submission.
 * Existing plans are updated by canonical row ID; draft rows are created only at submission. */
import { useEffect, useMemo, useRef, useState } from "react";
import { registerTab, type TabProps } from "../contributions";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { MdxDoc } from "../ui-kit/MdxDoc";
import { DateTimePicker } from "../ui-kit/DateTimePicker";
import { copyText } from "../ui-kit/ContextMenu";
import { useLiveMeetings, refreshMeetings } from "./liveMeetings";
import type { MeetingMock } from "./meetingModel";
import { presentError, readApiFailure } from "./apiClient";
import { resolveJoinError, type ServiceDenialPresentation } from "./serviceDenial";
import { ServiceDenialPanel } from "./ServiceDenialPanel";
import { createPlannedMeeting, updatePlannedMeeting, deletePlannedMeeting, type PlannedMeetingRow } from "./plannedApi";
import { createSharedWorkspace, listSharedMemberships, listWorkspaceTree, mintInvite, readWorkspaceFile, type Membership } from "./workspaceApi";
import { findBriefNote, isExampleNote } from "./briefNote";
import { manageTabDescriptor } from "./workspaceManage";
import { defaultBotName } from "./defaultBotName";
import { ASK_CHAT_EVENT } from "../canvas/actions";

const field = {
  fontSize: 12.5, padding: "6px 8px", background: "var(--panel)", border: "1px solid var(--line)",
  borderRadius: 7, color: "var(--t1)", outline: "none",
} as const;
const label = { fontSize: 10.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 } as const;
// Calendar PARTSTAT arrives as an iCal slug (accepted · declined · tentative · needs-action ·
// delegated); the attendee tooltip names it in Turkish while the code keeps comparing the slug.
const PARTSTAT_LABEL: Record<string, string> = {
  accepted: "kabul etti",
  declined: "reddetti",
  tentative: "kararsız",
  "needs-action": "yanıt vermedi",
  delegated: "devretti",
};
const partstatLabel = (partstat: string) => PARTSTAT_LABEL[partstat] ?? partstat;

/** THE BRIEF (prep-v3, owner-locked): the workspace README rendered as the page's stage — ONE doc,
 *  team-facing, always the next occurrence's brief. A SEEDED stub never renders as content (bloat
 *  law 3); missing/seeded → honest empty state whose CTA names its output. The interview itself
 *  happens in the chat rail (no question UI here) — this block is the RESULT of that dialogue. */
// slug-aware doc tab (same shape as workspace.tsx docTab): opens a file from the BOUND workspace.
const wsDocTab = (slug: string, path: string, title?: string) =>
  ({ id: `doc:${slug}:${path}`, title: title ?? (path.split("/").pop() ?? path), kind: "doc", params: { path, slug } });

const SEED_README_MARK = "Kişisel çalışma alanınızdır";

function Brief({ slug, title }: { slug: string; title: string }) {
  const layout = useService(LayoutServiceId);
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"readme" | "none" | "loading">("loading");
  useEffect(() => {
    let alive = true;
    setState("loading");
    void readWorkspaceFile("README.md", { slug })
      .then((t) => {
        if (!alive) return;
        // a fresh workspace's seeded README is system exhaust, not a brief
        if (!t || !t.trim() || t.slice(0, 400).includes(SEED_README_MARK)) setState("none");
        else { setText(t); setState("readme"); }
      })
      .catch(() => { if (alive) setState("none"); });
    return () => { alive = false; };
  }, [slug]);
  const askForBrief = () => window.dispatchEvent(new CustomEvent(ASK_CHAT_EVENT, {
    detail: { prompt: `"${title}" toplantısının hazırlık notunu ${slug} çalışma alanının README dosyasına hazırla — kimler katılıyor (kayıtlarımızda araştır), geçen sefer ne konuşulmuştu, açık takip işleri ve önerilen bir gündem. Kayıtlardan bilemeyeceklerini bana sor.` },
  }));
  if (state === "loading") return null;
  if (state === "none" || !text) {
    return (
      <div style={{ margin: "18px 0 0", padding: "12px 14px", border: "1px dashed var(--line2)", borderRadius: 10, fontSize: 12.5, color: "var(--t3)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ flex: 1, minWidth: 200 }}>Henüz hazırlık notu yok.</span>
        <button onClick={askForBrief} style={{ background: "var(--accentbg)", color: "var(--accent)", border: "none", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", flex: "none" }}>
          Hazırlık notunu oluştur — katılımcılar, geçen sefer, açık maddeler, gündem
        </button>
      </div>
    );
  }
  return (
    <div style={{ margin: "18px 0 0", border: "1px solid var(--line)", borderRadius: 10, background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px 0" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flex: "none" }} />
        <span style={{ fontSize: 10, color: "var(--t3)", letterSpacing: ".08em", fontFamily: "var(--mono)" }}>
          ekip hazırlık notu · çalışma alanı README
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => layout.openTab(wsDocTab(slug, "README.md"))}
          title="Belge olarak aç" style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
          aç
        </button>
        <button onClick={askForBrief} title="Hazırlık notunu sohbet üzerinden yönlendirin"
          style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
          sohbetten güncelle
        </button>
      </div>
      <div style={{ padding: "4px 16px 12px", maxHeight: 460, overflow: "auto" }}>
        <MdxDoc style={{ fontSize: 13, lineHeight: 1.55 }}>{text}</MdxDoc>
      </div>
    </div>
  );
}

/** Own-workspace brief (frame 6, owner-ruled 2026-07-09): with NO shared workspace bound, the brief
 *  is this meeting's note in the user's OWN workspace — and the prep page renders it LIVE while the
 *  brief chat writes it, instead of sitting on the "No brief yet" state. Polls the own-workspace
 *  tree (short interval while the tab is up — agents write mid-chat) and re-reads the note. */
const OWN_BRIEF_POLL_MS = 12_000;

function useOwnBriefNote(enabled: boolean, title: string, nativeId?: string | null) {
  const [note, setNote] = useState<{ path: string; text: string } | null>(null);
  useEffect(() => {
    if (!enabled) { setNote(null); return; }
    let alive = true;
    const look = async () => {
      try {
        const files = await listWorkspaceTree();
        const path = findBriefNote(files, { title, nativeId });
        if (!path) { if (alive) setNote(null); return; }
        const text = await readWorkspaceFile(path);
        if (!alive) return;
        if (!text || !text.trim() || isExampleNote(text)) setNote(null);
        else setNote({ path, text });
      } catch { /* keep the last good render — a poll blip must not blank the brief */ }
    };
    void look();
    const t = setInterval(() => { if (document.visibilityState === "visible") void look(); }, OWN_BRIEF_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [enabled, title, nativeId]);
  return note;
}

function OwnBrief({ note, onSteer }: { note: { path: string; text: string }; onSteer: () => void }) {
  const layout = useService(LayoutServiceId);
  return (
    <div style={{ margin: "18px 0 0", border: "1px solid var(--line)", borderRadius: 10, background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px 0" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flex: "none" }} />
        <span style={{ fontSize: 10, color: "var(--t3)", letterSpacing: ".08em", fontFamily: "var(--mono)" }}>
          hazırlık notunuz · bu toplantının notu
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => layout.openTab({ id: `doc:${note.path}`, title: note.path.split("/").pop() ?? note.path, kind: "doc", params: { path: note.path } })}
          title="Belge olarak aç" style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
          aç
        </button>
        <button onClick={onSteer} title="Hazırlık notunu sohbet üzerinden yönlendirin"
          style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
          sohbetten güncelle
        </button>
      </div>
      <div style={{ padding: "4px 16px 12px", maxHeight: 460, overflow: "auto" }}>
        <MdxDoc style={{ fontSize: 13, lineHeight: 1.55 }}>{note.text}</MdxDoc>
      </div>
    </div>
  );
}

// A synthetic empty PLANNED meeting for a DRAFT tab — no backend row yet. Idle intent so the prep
// form renders without a backend row until explicit submission.
const DRAFT_M: MeetingMock = {
  id: "", title: "", when: "", status: "past", live_status: "idle", platform: "Google Meet",
  participants: [], mentioned: [], actions: [], transcript: [], insights: [],
};

function MeetingPrepTab(props: TabProps) {
  return <MeetingPrepForm key={String(props.params.meetingId ?? "") || PREP_DRAFT_TAB_ID} {...props} />;
}

function MeetingPrepForm({ params }: TabProps) {
  const layout = useService(LayoutServiceId);
  const all = useLiveMeetings();
  const meetingId = String(params.meetingId ?? "");
  const isDraft = !meetingId && !!params.draft;   // "+ Plan a meeting" tab, no row created yet
  const found: MeetingMock | undefined = meetingId ? all.find((x) => x.id === meetingId) : undefined;
  // In a draft tab, render against the empty placeholder until the row is created (then we hand off
  // to the canonical prep:<id> tab). A real tab whose row hasn't loaded yet shows "Loading…" below.
  const m: MeetingMock | undefined = found ?? (isDraft ? DRAFT_M : undefined);
  const readOnly = !!m?.shared;
  const isIntent = m?.live_status === "idle" || m?.live_status === "scheduled";

  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [scheduledAt, setScheduledAt] = useState<string | undefined>(() => isDraft ? new Date().toISOString() : undefined);
  const [autoJoin, setAutoJoin] = useState(true);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [savedRow, setSavedRow] = useState<PlannedMeetingRow | null>(null);
  const savedId = useRef(meetingId);
  const submitting = useRef(false);
  const attemptedJoin = useRef<string | null>(null);
  const reconcileJoin = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const hasSavedRow = !!meetingId || !!savedRow;
  // Seed once per canonical form; feed refreshes preserve the local draft.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A refused Join renders as its own in-flow panel, not as the generic one-line error.
  const [denial, setDenial] = useState<ServiceDenialPresentation | null>(null);
  const [shares, setShares] = useState<Membership[]>([]);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);       // ⋯ row: link edit / unbind / delete
  const [rebindOpen, setRebindOpen] = useState(false);   // "change" → the bind select
  const [briefChatStarted, setBriefChatStarted] = useState(false); // own-brief interview dispatched

  // seed the form once PER MEETING (live refreshes must not clobber in-progress edits; a
  // preview swap to another meeting must re-seed)
  useEffect(() => {
    if (!m || seededFor === m.id) return;
    setTitle(m.title_custom ?? "");
    setLink(m.meeting_url ?? "");
    if (!isDraft) setScheduledAt(m.scheduled_at);
    setAutoJoin(m.auto_join !== false);
    setWorkspaceId(m.workspace_id ?? null);
    setSeededFor(m.id);
  }, [m, seededFor, isDraft]);

  useEffect(() => {
    void listSharedMemberships()
      .then((ms) => setShares(ms.filter((s) => s.role === "owner" || s.role === "contributor")))
      .catch(() => {});
  }, []);

  const submit = async (joinNow: boolean) => {
    if (!m || readOnly || submitting.current) return;
    if (joinNow && !link.trim()) { setErr("Katılmak için toplantı bağlantısını girin."); return; }
    if (!title.trim() && !link.trim()) { setErr("Toplantı başlığını veya bağlantısını girin."); return; }
    submitting.current = true;
    setBusy(true); setErr(null); setDenial(null);
    try {
      if (reconcileJoin.current && savedId.current) {
        const response = await fetch(`/api/meetings/${encodeURIComponent(savedId.current)}`, { cache: "no-store" });
        if (!response.ok) throw await readApiFailure(response, "/api/meetings");
        const current = await response.json() as PlannedMeetingRow & { shared?: boolean };
        if (!mounted.current) return;
        if (String(current.id) !== savedId.current || current.shared !== false) {
          throw new Error("Bu toplantıyı değiştirme yetkiniz doğrulanamadı.");
        }
        if (["requested", "joining", "awaiting_admission", "active", "needs_help", "needs_human_help", "stopping", "completed"].includes(current.status)) {
          refreshMeetings();
          layout.openTab({ id: `meeting:${current.id}`, title: title.trim() || "Toplantı", kind: "meeting", params: { meetingId: String(current.id) } });
          if (isDraft) layout.closeTab(PREP_DRAFT_TAB_ID);
          return;
        }
        if (current.status === "failed" && attemptedJoin.current === savedId.current) {
          // This explicit retry starts a new run; the failed run remains in history.
          savedId.current = "";
          setSavedRow(null);
        } else if (!["idle", "scheduled"].includes(current.status)) {
          throw new Error("Bu toplantı yeniden başlatılamıyor. Toplantılar listesinden durumunu kontrol edin.");
        }
        reconcileJoin.current = false;
      }
      const body = {
        title: title.trim() || null,
        meeting_url: link.trim() || null,
        scheduled_at: scheduledAt ?? null,
        workspace_id: workspaceId,
        // A manual Join cannot race an automatically armed schedule.
        auto_join: joinNow ? false : autoJoin,
      };
      const row = savedId.current
        ? await updatePlannedMeeting(savedId.current, body)
        : await createPlannedMeeting(body);
      savedId.current = String(row.id);
      if (!mounted.current) return;
      setSavedRow(row);
      if (joinNow) {
        if (!row.native_meeting_id) throw new Error("Toplantı bağlantısı doğrulanamadı.");
        attemptedJoin.current = String(row.id);
        const response = await fetch("/api/bots", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meeting_id: Number(row.id), platform: row.platform, native_meeting_id: row.native_meeting_id,
            meeting_url: row.constructed_meeting_url || link.trim(), bot_name: defaultBotName(),
          }),
        });
        if (!response.ok) throw await readApiFailure(response, "/api/bots");
        const joined = await response.json() as { id?: number | string };
        if (String(joined.id) !== String(row.id)) throw new Error("Katılım yanıtı kaydedilen toplantıyla eşleşmiyor.");
      }
      if (!mounted.current) return;
      refreshMeetings();
      const id = String(row.id);
      layout.openTab(joinNow
        ? { id: `meeting:${id}`, title: title.trim() || "Toplantı", kind: "meeting", params: { meetingId: id } }
        : prepTabDescriptor({ id, title: title.trim() || "Yeni toplantı" }));
      if (isDraft) layout.closeTab(PREP_DRAFT_TAB_ID);
    } catch (e) {
      if (!mounted.current) return;
      if (attemptedJoin.current === savedId.current) reconcileJoin.current = true;
      if (joinNow) {
        const state = resolveJoinError(e);
        if (state.kind === "denial") setDenial(state.presentation);
        else setErr(state.headline);
      } else setErr(presentError(e).headline);
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const sendNow = () => submit(true);

  const share = async () => {
    if (!m?.workspace_id || workspaceId !== m.workspace_id) return;
    setBusy(true); setErr(null);
    try {
      const inv = await mintInvite({ workspace_id: m.workspace_id, role: "contributor", mode: "open", expires_in_sec: 7 * 86400, max_uses: 50 });
      setInviteLink(`${window.location.origin}/?invite=${inv.token}`);
    } catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const createAndBind = async () => {
    if (!m || !hasSavedRow) return;
    setBusy(true); setErr(null);
    try {
      const name = (m.title_custom || title || "toplanti-hazirlik").slice(0, 60);
      const ws = await createSharedWorkspace(name);
      setWorkspaceId(ws.workspace_id);
      setShares((items) => [...items, { workspace_id: ws.workspace_id, role: "owner" } as Membership]);
      // Creating the shared workspace IS a scaffolding run (prep-v3 ruling, owner 2026-07-09):
      // the agent must know the workspace is brand-new and exists to collaborate with the other
      // participants around this meeting — its README is the team brief. Any brief already built
      // in the user's own workspace is the starting point, not discarded.
      const carry = ownBrief
        ? ` Bu toplantı için kendi çalışma alanımda ${ownBrief.path} yolunda hâlihazırda bir hazırlık notum var — içeriğini başlangıç notu olarak oraya taşı, sonra geliştirmeye devam et.`
        : "";
      window.dispatchEvent(new CustomEvent(ASK_CHAT_EVENT, {
        detail: { prompt: `"${m.title_custom || title || headline}" toplantısı için "${ws.workspace_id}" paylaşılan çalışma alanını az önce oluşturdum — tamamen yeni (boş) ve diğer katılımcılarla bu toplantı ve serisi üzerinde birlikte çalışabilmemiz için var. Şimdi iskeletini kur: README dosyasını ekip hazırlık notu olarak yaz (hedef kitle = odadaki herkes, bu yüzden ben onaylamadıkça özel bağlamımı dışarıda bırak), serinin ihtiyaç duyduğu yapıyı kur ve kayıtlarımdan bilemeyeceklerini bana sor.${carry} Erken yazmaya başla ve konuştukça güncellemeyi sürdür — README, toplantı sayfasında canlı olarak görüntüleniyor.` },
      }));
    } catch (e) { if (mounted.current) setErr(presentError(e).headline); }
    finally { if (mounted.current) setBusy(false); }
  };

  // Preparation actions require an explicitly saved canonical meeting.
  const startBriefChat = async () => {
    if (!hasSavedRow) return;
    setBusy(true); setErr(null);
    try {
      const id = savedId.current;
      // re-read the row so the note filename can key to its native id if a link was set
      const row = all.find((x) => x.id === id);
      const name = row?.title_custom || title || "bu toplantı";
      const nid = row?.native_id ?? savedRow?.native_meeting_id;
      const key = nid ? ` Not dosyasının adını ${nid} toplantı kimliğini içerecek şekilde ver (kg/entities/meeting/…${nid}….md) — toplantı sayfası notu bu kimlikle bulup gösteriyor.` : "";
      setBriefChatStarted(true);
      window.dispatchEvent(new CustomEvent(ASK_CHAT_EVENT, {
        detail: { prompt: `"${name}" için hazırlık notunu oluşturmak üzere benimle görüş — kayıtlarımdan bilemeyeceklerini sor (odada kimler var, bu toplantıdan ne bekliyorum, botun nelere kulak vermesi gerekiyor), katılımcıları bilgi alanımda ve açık kaynaklarda araştır, ardından hazırlık notunu bu toplantının notu olarak kendi çalışma alanıma yaz (paylaşılan çalışma alanı olmadan) ki bu toplantının serisi boyunca yeniden kullanılabilsin.${key} Notu ERKEN yaz ve konuştukça güncellemeyi sürdür — not, toplantı sayfasında canlı olarak görüntüleniyor.` },
      }));
    } catch (e) { if (mounted.current) setErr(presentError(e).headline); }
    finally { if (mounted.current) setBusy(false); }
  };

  const remove = async () => {
    if (!m) return;
    if (!savedId.current) { layout.closeTab(PREP_DRAFT_TAB_ID); return; }   // nothing persisted — just discard the draft
    if (typeof window !== "undefined" && !window.confirm("Bu planlanan toplantı silinsin mi?")) return;
    setBusy(true);
    try { await deletePlannedMeeting(savedId.current); refreshMeetings(); layout.closeTab(isDraft ? PREP_DRAFT_TAB_ID : `prep:${savedId.current}`); }
    catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const headline = useMemo(() => m?.title_custom || m?.title || "Planlanan toplantı", [m]);
  // own-workspace brief (frame 6): only hunted while the meeting is unbound — a bound workspace's
  // README is the brief and wins.
  // No brief hunt on a draft (no row/title yet) — it would match nothing or the wrong note.
  const ownBrief = useOwnBriefNote(!isDraft && !!m && !m.workspace_id && !readOnly && isIntent, headline, m?.native_id);

  // B2 tab hygiene: a calendar sweep DELETES + recreates rows (new ids) — a tab keyed to the old
  // row would dangle on "Loading meeting…" forever. Once the store has data and the row is gone,
  // the tab closes itself (the meeting lives on under its new row, reachable from Today).
  // Grace: only self-close a row we have ACTUALLY SEEN (then lost). A just-created tab whose row
  // hasn't loaded into the store yet (the draft → prep:<id> hand-off) must NOT close — it loads in.
  const everSeen = useRef(false);
  useEffect(() => { if (found) everSeen.current = true; }, [found]);
  const rowGone = !isDraft && !!meetingId && everSeen.current && all.length > 0 && !found;
  useEffect(() => {
    if (rowGone) layout.closeTab(`prep:${meetingId}`);
  }, [rowGone, layout, meetingId]);

  if (!m) {
    return <div style={{ padding: 32, fontSize: 13, color: "var(--t3)" }}>Toplantı yükleniyor…</div>;
  }
  if (!isIntent && !attemptedJoin.current) {
    return (
      <div style={{ padding: 32, fontSize: 13, color: "var(--t2)", lineHeight: 1.6 }}>
        Bu toplantı başladı — canlı görünüm için Toplantılar listesinden açın.
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto", boxSizing: "border-box", padding: "24px 28px" }}>
      <div style={{ maxWidth: 640 }}>
        {/* TITLE-FIRST hero (prep-v3 carve): no status pills — the page you're on IS the state.
            Title editable in place, honest placeholder, never the "platform · (no link)" fallback. */}
        {readOnly ? (
          <h2 style={{ margin: "0 0 18px", fontSize: 19, fontWeight: 650, color: "var(--t1)" }}>{headline}</h2>
        ) : (
          <input value={title} disabled={busy} placeholder="Bu toplantı ne hakkında?"
            onChange={(e) => setTitle(e.target.value)}
            style={{ display: "block", width: "100%", boxSizing: "border-box", margin: "0 0 18px", padding: "2px 0 6px",
              fontSize: 19, fontWeight: 650, color: "var(--t1)", background: "transparent", border: "none",
              borderBottom: "1px dashed var(--line2)", outline: "none" }} />
        )}

        {m.auto_join_error && (
          <div role="alert" style={{ margin: "0 0 14px", padding: "8px 12px", borderRadius: 8, background: "var(--dangerbg)", color: "var(--danger)", fontSize: 12.5, lineHeight: 1.5 }}>
            ⚠ Otomatik katılım başarısız: {m.auto_join_error}
          </div>
        )}

        {/* ── meta line (prep-v3 carve): when · Join · auto-join — the raw URL lives behind ⋯ ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
          <DateTimePicker
            value={scheduledAt}
            disabled={readOnly || busy}
            placeholder="Tarih ve saat seçin"
            onChange={setScheduledAt}
            onClear={() => setScheduledAt(undefined)}
          />
          {m.meeting_url && (
            /* "Open meeting" not "Join" — the human opens the URL; the notetaker is a separate verb
               (first-run-onboarding frame 6: Join/Send-bot/Auto-join read as flavors of one verb). */
            <a href={m.meeting_url} target="_blank" rel="noreferrer"
              style={{ background: "var(--accent)", color: "var(--on-accent)", borderRadius: 7, padding: "5px 14px", fontSize: 12.5, fontWeight: 600, textDecoration: "none" }}>
              Toplantıyı aç
            </a>
          )}
          {!readOnly && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--t2)", cursor: "pointer", userSelect: "none" }}>
              <input type="checkbox" checked={autoJoin} disabled={busy}
                onChange={(e) => setAutoJoin(e.target.checked)} />
              Otomatik katılım{!link.trim() && <span style={{ color: "var(--t3)", fontSize: 11 }}>(bağlantı gerekiyor)</span>}
            </label>
          )}
        </div>
        {/* no link yet → the input is the honest primary control; with a link it lives in ⋯ */}
        {!readOnly && (!m.meeting_url || moreOpen) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "8px 0 4px", maxWidth: 420 }}>
            <span style={label}>Toplantı bağlantısı</span>
            <input value={link} disabled={busy} placeholder="https://meet.google.com/…"
              onChange={(e) => setLink(e.target.value)}
              style={field} />
          </div>
        )}

        {!readOnly && <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "16px 0" }}>
          <button className="primary-button" disabled={busy} onClick={() => void submit(false)}>Planla</button>
          <button className="secondary-button" disabled={busy || !link.trim()} onClick={() => void sendNow()}>Katıl</button>
          <span style={{ fontSize: 12, color: "var(--t3)" }}>Değişiklikler bu düğmelerden birine bastığınızda kaydedilir.</span>
          {!hasSavedRow && <span style={{ fontSize: 12, color: "var(--t3)" }}>Önce Planla veya Katıl düğmesine basın; ardından hazırlık ve paylaşım yapabilirsiniz.</span>}
        </div>}

        {/* ── attendees (calendar ATTENDEE lines → data.attendees, prep-v3 slice b) ── */}
        {(m.attendees?.length ?? 0) > 0 && (
          <div style={{ margin: "0 0 22px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
              <span style={label}>Katılımcılar</span>
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
              {m.attendees!.map((a) => {
                const display = a.name || a.email;
                const initials = (a.name
                  ? a.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")
                  : a.email.slice(0, 2)).toLocaleUpperCase("tr-TR");
                const declined = a.partstat === "declined";
                return (
                  <span key={a.email} title={a.email + (a.partstat ? ` · ${partstatLabel(a.partstat)}` : "")}
                    style={{ display: "inline-flex", alignItems: "center", gap: 7,
                      border: "1px solid var(--line)", borderRadius: 14, padding: "2px 11px 2px 3px",
                      fontSize: 12.5, color: declined ? "var(--t3)" : "var(--t1)",
                      textDecoration: declined ? "line-through" : undefined }}>
                    <span style={{ width: 19, height: 19, borderRadius: "50%", background: "var(--panel2)",
                      color: "var(--t2)", display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 8.5, fontWeight: 700 }}>{initials}</span>
                    {display}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* ── ONE quiet utility row (prep-v3 carve): workspace as a word · share · send · ⋯ ──
            Moved to the TOP (owner ruling): the actions sit above the brief so a long brief never
            buries them. The popouts (rebind select, ⋯ block, invite link) render right here. */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--line)", fontSize: 12, color: "var(--t3)" }}>
          {workspaceId && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}>
              çalışma alanı{" "}
              <button onClick={() => layout.openTab(manageTabDescriptor(workspaceId!, { shared: true }))}
                title={workspaceId}
                style={{ background: "none", border: "none", color: "var(--t2)", fontWeight: 600, fontSize: 12, cursor: "pointer", padding: 0 }}>
                {workspaceId.replace(/-[0-9a-f]{4,}$/i, "")}
              </button>
              {!readOnly && (
                <button onClick={() => setRebindOpen((v) => !v)}
                  style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11.5, cursor: "pointer", padding: 0, borderBottom: "1px dotted var(--t3)" }}>
                  değiştir
                </button>
              )}
            </span>
          )}
          {/* an own brief (or one in flight) must NOT hide the sharing path — the no-brief
              placeholder's share button vanished exactly when there was something worth sharing
              (owner ruling 2026-07-09) */}
          {!readOnly && !workspaceId && (ownBrief || briefChatStarted) && (
            <button disabled={busy || !hasSavedRow} onClick={() => void createAndBind()}
              title="Davet ettiğiniz herkes katıldığı anda hazırlık notunu ve canlı transkripti görür"
              style={{ background: "none", border: "none", color: "var(--t2)", fontSize: 12, cursor: "pointer", padding: 0, borderBottom: "1px dotted var(--t3)" }}>
              + Paylaşmak için çalışma alanı oluştur
            </button>
          )}
          {readOnly && <span style={{ fontSize: 11.5 }}>sizinle paylaşıldı</span>}
          <span style={{ flex: 1 }} />
          {!readOnly && workspaceId && (
            <button disabled={busy || workspaceId !== m.workspace_id} onClick={() => void share()}
              style={{ background: "none", border: "none", color: "var(--t2)", fontSize: 12, cursor: "pointer", padding: 0, borderBottom: "1px dotted var(--t3)" }}>
              Katılımcılarla paylaş{(m.attendees?.length ?? 0) > 0 ? ` (${m.attendees!.length})` : ""}
            </button>
          )}
          {!readOnly && (
            <button onClick={() => setMoreOpen((v) => !v)} title="Daha fazla — bağlantıyı düzenle, çalışma alanı bağını kaldır, sil"
              style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 14, cursor: "pointer", padding: "0 2px" }}>
              ⋯
            </button>
          )}
        </div>
        {rebindOpen && !readOnly && shares.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <select defaultValue="" disabled={busy}
              onChange={(e) => { if (e.target.value) { setWorkspaceId(e.target.value); setRebindOpen(false); } }}
              style={{ ...field, minWidth: 200 }}>
              <option value="" disabled>Farklı bir çalışma alanı bağlayın…</option>
              {shares.map((s) => <option key={s.workspace_id} value={s.workspace_id}>{s.workspace_id}</option>)}
            </select>
          </div>
        )}
        {moreOpen && !readOnly && (
          <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
            {workspaceId && (
              <button disabled={busy} onClick={() => { setWorkspaceId(null); setMoreOpen(false); }}
                style={{ background: "transparent", border: "1px solid var(--line2)", color: "var(--t3)", borderRadius: 7, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
                Çalışma alanı bağını kaldır
              </button>
            )}
            <button disabled={busy} onClick={() => void remove()}
              style={{ background: "transparent", border: "1px solid var(--line2)", color: "var(--danger)", borderRadius: 7, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
              Toplantıyı sil
            </button>
          </div>
        )}
        {inviteLink && (
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <input readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} style={{ ...field, flex: 1, fontSize: 11.5 }} />
            <button onClick={() => void copyText(inviteLink)} style={{ fontSize: 12, padding: "4px 12px", background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 7, cursor: "pointer" }}>Kopyala</button>
          </div>
        )}

        {/* ── the brief = the stage (prep-v3 carve) ───────────────── */}
        {workspaceId ? (
          <Brief slug={workspaceId} title={headline} />
        ) : readOnly ? (
          <div style={{ margin: "18px 0 0", fontSize: 12.5, color: "var(--t3)" }}>Bağlı çalışma alanı yok.</div>
        ) : ownBrief ? (
          /* the own-workspace note IS the brief — rendered live while the chat writes it */
          <OwnBrief note={ownBrief} onSteer={() => startBriefChat()} />
        ) : briefChatStarted ? (
          <div style={{ margin: "18px 0 0", padding: "12px 14px", border: "1px dashed var(--line2)", borderRadius: 10, display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--t3)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flex: "none" }} />
            Hazırlık sohbeti sürüyor — asistan yazdıkça hazırlık notu burada görünür.
          </div>
        ) : (
          /* No-brief state (first-run-onboarding frame 6, owner-ruled): two REAL actions. Brief chat
             = the agent interviews you here (the prep tab's meeting grounding rides the turn) and the
             brief lands in YOUR default workspace, reused across the series. Shared workspace = the
             existing collaborative flow, repositioned as the explicit sharing choice. */
          <div style={{ margin: "18px 0 0", padding: "12px 14px", border: "1px dashed var(--line2)", borderRadius: 10, display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)" }}>Henüz hazırlık notu yok</div>
            <div style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.55 }}>
              Hazırlık notu botu işe yarar hale getirir — odada kimler var, bu toplantıdan ne
              beklediğiniz, nelere kulak vermesi gerektiği.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button disabled={busy || !hasSavedRow} onClick={() => startBriefChat()}
                style={{ background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Hazırlık sohbetini başlat
              </button>
              <button disabled={busy || !hasSavedRow} onClick={() => void createAndBind()}
                style={{ background: "transparent", color: "var(--accent)", border: "1px dashed var(--line2)", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                + Paylaşmak için çalışma alanı oluştur
              </button>
              {shares.length > 0 && (
                <select defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) setWorkspaceId(e.target.value); }}
                  style={{ ...field, minWidth: 180, color: "var(--t3)" }}>
                  <option value="" disabled>veya mevcut birini bağlayın…</option>
                  {shares.map((s) => <option key={s.workspace_id} value={s.workspace_id}>{s.workspace_id}</option>)}
                </select>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.5 }}>
              <b style={{ color: "var(--t2)", fontWeight: 600 }}>Hazırlık sohbeti</b> — asistan sizinle görüşür ve
              hazırlık notunu kendi çalışma alanınıza yazar; bu serinin tamamında yeniden kullanılır.{" "}
              <b style={{ color: "var(--t2)", fontWeight: 600 }}>Paylaşılan çalışma alanı</b> — davet ettiğiniz
              herkes katıldığı anda hazırlık notunu ve canlı transkripti görür.
            </div>
          </div>
        )}

        {denial && <ServiceDenialPanel presentation={denial} onRetry={() => void sendNow()} />}
        {err && <div role="alert" style={{ marginTop: 12, fontSize: 12, color: "var(--danger)" }}>⚠ {err}</div>}
      </div>
    </div>
  );
}

export const prepTabDescriptor = (m: { id: string; title: string }) =>
  ({ id: `prep:${m.id}`, title: m.title, kind: "meetingPrep", params: { meetingId: m.id } });

// One local draft page. Abandoning it before submission creates no backend meeting.
export const PREP_DRAFT_TAB_ID = "prep:draft";
export const prepDraftTabDescriptor = () =>
  ({ id: PREP_DRAFT_TAB_ID, title: "Yeni toplantı", kind: "meetingPrep", params: { meetingId: "", draft: true } });

registerTab("meetingPrep", MeetingPrepTab);
