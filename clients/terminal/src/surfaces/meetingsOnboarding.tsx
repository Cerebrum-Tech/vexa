"use client";
/** Meetings user onboarding — the per-user half of the first-run flow (design-spec
 *  first-run-onboarding, frames 4–5). EVERY new user lands here; the admin wizard hands into it
 *  via "Go to Meetings". Two skins over one state:
 *
 *    - `full` — the empty-Meetings center stage: three cards ordered by leverage (connect
 *      calendar / plan a meeting / drop a bot on a running Meet).
 *    - `slim` — the STANDING calendar affordance: a single connect card that stays on the
 *      Meetings page for as long as THIS user has no calendar connected (state-driven, not
 *      visit-count-driven). Renders nothing once connected.
 *
 *  The connect surface TEACHES where the secret iCal URL lives (the step users bounce off),
 *  including the two field-tested traps (public-vs-secret address, Workspace-admin lock), and
 *  answers immediately on connect — sync-now runs and reports what it found. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { defaultBotName } from "./defaultBotName";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { parseMeetingInput } from "./meetingId";
import { readApiFailure } from "./apiClient";
import { resolveJoinError, type ServiceDenialPresentation } from "./serviceDenial";
import { ServiceDenialPanel } from "./ServiceDenialPanel";
import { getJitsiHosts } from "./jitsiHosts";
import { presentError } from "./apiClient";
import { refreshMeetings } from "./liveMeetings";
import { listCalendars, createCalendar, syncCalendar, type CalendarSyncStamp } from "./plannedApi";
import { prepDraftTabDescriptor } from "./meetingPrep";

/** The success line after a connect: lead with what the sync actually FOUND. */
export function connectOutcome(stamp: CalendarSyncStamp): { ok: boolean; text: string } {
  if (stamp.last_error) return { ok: false, text: `Takvim bağlandı ancak ilk eşitleme başarısız oldu: ${stamp.last_error}` };
  const found = (stamp.counts?.created ?? 0) + (stamp.counts?.updated ?? 0);
  return {
    ok: true,
    text: found > 0
      ? `Takvim bağlandı — ${found} yaklaşan toplantı içe aktarıldı.`
      : "Takvim bağlandı — katılınabilir bağlantısı olan yaklaşan bir toplantı henüz bulunamadı.",
  };
}

const cardBase: CSSProperties = {
  border: "1px dashed var(--line2)", borderRadius: 10, padding: "14px 15px",
  display: "flex", flexDirection: "column", gap: 6, textAlign: "left",
};
const cardTitle: CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--t1)", display: "flex", alignItems: "center", gap: 7 };
const cardBody: CSSProperties = { fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, flex: 1 };
const cta: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" };
const fieldStyle: CSSProperties = {
  flex: 1, minWidth: 0, background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: 7,
  padding: "7px 9px", color: "var(--t1)", fontSize: 12, outline: "none",
};

/** Loading tri-state so neither skin flashes: null = unknown yet. "Connected" is now "this user
 *  has at least one calendar CONNECTION" — the first-run card is about having none at all; the
 *  second, third… calendar is added from Settings → Calendar. */
function useCalendarConnected(): [boolean | null, () => void] {
  const [connected, setConnected] = useState<boolean | null>(null);
  const probe = () => {
    listCalendars().then((l) => setConnected(l.length > 0)).catch(() => setConnected(null));
  };
  useEffect(probe, []);
  return [connected, probe];
}

/** The frame-5 connect modal: numbered secret-address walkthrough + paste + instant verdict.
 *  This is FIRST-connect only, so it creates connection #1 with a sensible default name; renaming
 *  it, adding more, and per-calendar policy all live in Settings → Calendar. */
const DEFAULT_CALENDAR_NAME = "Takvimim";

function ConnectCalendarModal({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState(DEFAULT_CALENDAR_NAME);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ ok: boolean; text: string } | null>(null);

  const connect = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const created = await createCalendar({
        name: name.trim() || DEFAULT_CALENDAR_NAME, ics_url: u, auto_join: true,
      });
      // paste → an ANSWER, not a silent wait (the backend does not sync on create)
      let stamp: CalendarSyncStamp = {};
      try { stamp = await syncCalendar(created.id); } catch (e) {
        stamp = { last_error: presentError(e).detail };  // data stays raw (telemetry) — UI renders the presented stamp
      }
      refreshMeetings();
      setDone(connectOutcome(stamp));
      onConnected();
    } catch (e) {
      setErr(presentError(e).headline);
    } finally {
      setBusy(false);
    }
  };

  const li: CSSProperties = { display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px dashed var(--line)", fontSize: 12, color: "var(--t2)", lineHeight: 1.5 };
  const num: CSSProperties = { flex: "none", width: 18, height: 18, borderRadius: "50%", background: "var(--panel2)", color: "var(--accent)", fontSize: 10.5, fontWeight: 700, display: "grid", placeItems: "center", marginTop: 1 };

  return (
    <div role="dialog" aria-label="Takviminizi bağlayın"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 520, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto", background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 12, padding: "20px 22px", boxShadow: "0 18px 40px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: 15, fontWeight: 650, color: "var(--t1)", flex: 1 }}>Takviminizi bağlayın</span>
          <button aria-label="kapat" onClick={onClose} style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 16, cursor: "pointer", padding: 2 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}>
          Innova Toplantı Asistanı takviminizi <b style={{ color: "var(--t2)" }}>gizli iCal adresi</b> üzerinden okur — bu,
          yalnızca sizin görebildiğiniz özel bir adrestir. Google ile giriş yapmanız gerekmez. Outlook ve
          Apple Calendar ICS akışları da aynı kutudan çalışır.
        </div>
        <div>
          <div style={li}><span style={num}>1</span><span>Tarayıcınızda <b>Google Calendar</b> uygulamasını açın → ⚙ <b>Ayarlar</b>.</span></div>
          <div style={li}><span style={num}>2</span><span>Soldaki listede <b>Takvimlerimin ayarları</b> bölümünden takviminize tıklayın.</span></div>
          <div style={li}><span style={num}>3</span><span><b>Takvimi entegre et</b> bölümüne inin → <b>iCal biçimindeki gizli adres</b> alanını kopyalayın. <span style={{ color: "var(--t3)" }}>Herkese açık adresi değil — gizli adres uzun bir belirteçle biter.</span></span></div>
          <div style={{ ...li, borderBottom: "none", color: "var(--t3)" }}><span style={num}>4</span><span>Gizli adres alanını göremiyor musunuz? Google Workspace yöneticiniz bu ayarı kilitlemiştir — &ldquo;Gizli adres&rdquo; paylaşımını açmasını isteyin veya kişisel bir takvim kullanın.</span></div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={100}
            aria-label="Takvim adı" placeholder="Takvim adı"
            style={{ ...fieldStyle, flex: "none", width: 130 }} />
          <input value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy}
            type="password" autoComplete="off" aria-label="Gizli ICS adresi"
            onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
            placeholder="https://calendar.google.com/…/basic.ics (gizli adres)" style={fieldStyle} />
          <button onClick={() => void connect()} disabled={busy || !url.trim()}
            style={{ flex: "none", background: url.trim() ? "var(--accent)" : "var(--panel2)", color: url.trim() ? "var(--on-accent)" : "var(--t3)", border: "none", borderRadius: 7, padding: "0 14px", fontSize: 12.5, fontWeight: 600, cursor: url.trim() && !busy ? "pointer" : "default" }}>
            {busy ? "Bağlanıyor…" : "Bağlan"}
          </button>
        </div>
        {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", lineHeight: 1.5 }}>⚠ {err}</div>}
        {done && (
          <div role={done.ok ? "status" : "alert"} style={{ fontSize: 11.5, color: done.ok ? "var(--green)" : "var(--danger)", lineHeight: 1.5 }}>
            {done.ok ? "✓" : "⚠"} {done.text}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "var(--t3)" }}>Birkaç dakikada bir eşitlenir · Ayarlar → Takvim bölümünden takvim ekleyebilir, yeniden adlandırabilir veya bağlantıyı kesebilirsiniz</span>
          {done?.ok && <button onClick={onClose} style={{ background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 7, padding: "7px 16px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Tamam</button>}
        </div>
      </div>
    </div>
  );
}

/** Join an ongoing meeting through the authenticated bot endpoint. */
export function JoinMeetingForm({ onJoined, prominent = false }: { onJoined?: (meetingId: string) => void; prominent?: boolean }) {
  const pending = useRef(false);
  const [url, setUrl] = useState("");
  const [sent, setSent] = useState<null | "sending" | "ok" | "err">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [denial, setDenial] = useState<ServiceDenialPresentation | null>(null);
  const send = async () => {
    const u = url.trim();
    if (!u || pending.current) return;
    pending.current = true;
    setSent("sending"); setMsg(null); setDenial(null);
    try {
      const parsed = parseMeetingInput(u, await getJitsiHosts());
      if (!parsed) { setSent("err"); setMsg("Bu, bir Meet / Zoom / Teams / Jitsi bağlantısına benzemiyor."); return; }
      const r = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: parsed.platform, native_meeting_id: parsed.native_meeting_id, meeting_url: u, bot_name: defaultBotName() }),
      });
      if (r.ok) {
        const result = await r.json();
        setSent("ok"); setUrl("");
        refreshMeetings(); setTimeout(refreshMeetings, 2000); setTimeout(refreshMeetings, 6000);
        if (result.id != null) onJoined?.(String(result.id));
      } else {
        setSent("err");
        if (r.status === 429) setMsg("Toplantı sınırınıza ulaştınız — önce birini durdurun.");
        else if (r.status === 409) setMsg("Bu toplantıda zaten bir bot var.");
        else if (r.status === 401) setMsg("Giriş yapılmadı — giriş yapıp yeniden deneyin.");
        else {
          // Service-authority refusals retain their action panel until the next attempt.
          const state = resolveJoinError(await readApiFailure(r, "/api/bots"));
          if (state.kind === "denial") { setDenial(state.presentation); setMsg(null); }
          else setMsg(state.headline);
        }
      }
    } catch { setSent("err"); setMsg("Sunucuya ulaşılamadı."); }
    finally { pending.current = false; }
  };
  return (
    <form aria-label="Canlı toplantıya katıl" className={prominent ? "meeting-quick-join-form" : undefined} onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className={prominent ? "meeting-quick-join-fields" : undefined} style={{ display: "flex", gap: 8 }}>
        <input aria-label="Toplantı bağlantısı" value={url} onChange={(e) => setUrl(e.target.value)} disabled={sent === "sending"} autoComplete="off" autoCapitalize="none" spellCheck={false}
          placeholder="Toplantı bağlantısını yapıştırın (Meet / Zoom / Teams / Jitsi)…" style={prominent ? undefined : fieldStyle} />
        <button type="submit" disabled={!url.trim() || sent === "sending"} className={prominent ? "meeting-library-primary" : undefined}
          style={prominent ? undefined : { flex: "none", background: url.trim() ? "var(--accent)" : "var(--panel2)", color: url.trim() ? "var(--on-accent)" : "var(--t3)", border: "none", borderRadius: 7, padding: "0 10px", fontSize: 12, fontWeight: 600, cursor: url.trim() ? "pointer" : "default" }}>
          {sent === "sending" ? "Katılıyor…" : prominent ? "Hemen katıl" : "Botu gönder"}
        </button>
      </div>
      {sent === "ok" && <div role="status" style={{ fontSize: 12, color: "var(--green)", lineHeight: 1.4 }}>Asistan katılıyor — gerekirse toplantıda kabul edin.</div>}
      {denial
        ? <ServiceDenialPanel presentation={denial} onRetry={() => void send()} />
        : sent === "err" && msg && <div role="alert" style={{ fontSize: 11, color: "var(--danger)", lineHeight: 1.4 }}>⚠ {msg}</div>}
    </form>
  );
}

export function MeetingsOnboarding({ variant, showJoin = true }: { variant: "full" | "slim"; showJoin?: boolean }) {
  const [connected, reprobe] = useCalendarConnected();
  const [modal, setModal] = useState(false);
  const layout = useService(LayoutServiceId);
  // "+ Plan a meeting" opens a DRAFT prep tab — no backend row until the user fills something in, so
  // an abandoned draft leaves no empty meeting behind (the prep tab creates the row lazily).
  const plan = () => layout.openTab(prepDraftTabDescriptor());

  // slim = the STANDING affordances on a populated Meetings page: plan + drop-bot are ALWAYS
  // available (owner ruling 2026-07-09); the calendar card additionally shows while this user
  // has no calendar connected.
  if (variant === "slim") {
    return (
      <>
        {connected === false && (
          <div style={{ ...cardBase, flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 }}>
            <Icon name="cal" size={15} style={{ color: "var(--t3)", flex: "none" }} />
            <span style={{ ...cardBody, flex: 1 }}>
              <b style={{ color: "var(--t2)" }}>Bağlı takvim yok</b> — takviminizin gizli ICS akışını bağlayın;
              zamanlanmış toplantılar burada kendiliğinden görünsün. Otomatik katılım açıkken bot, toplantı
              başladığında katılır.
            </span>
            <button style={{ ...cta, flex: "none" }} onClick={() => setModal(true)}>Takvimi bağla →</button>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button onClick={() => plan()}
            style={{ flex: "none", background: "transparent", border: "1px dashed var(--line2)", color: "var(--t2)", borderRadius: 7, padding: "7px 11px", fontSize: 12, cursor: "pointer" }}>
            + Toplantı planla
          </button>
          {showJoin && <div style={{ flex: 1, minWidth: 220 }}><JoinMeetingForm /></div>}
        </div>
        {modal && <ConnectCalendarModal onClose={() => setModal(false)} onConnected={reprobe} />}
      </>
    );
  }

  // full = the empty-Meetings center stage (frame 4): three paths, calendar primary.
  return (
    <>
      <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--t3)" }}>
        Burada henüz bir şey yok — toplantıların buraya nasıl geleceğini seçin.
      </div>
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {connected !== true && (
          <div style={{ ...cardBase, border: "1px solid var(--accent)", background: "var(--panel)" }}>
            <span style={cardTitle}><Icon name="cal" size={14} /> Takviminizi bağlayın</span>
            <span style={cardBody}>
              Tek seferlik kurulum. Zamanlanmış toplantılar burada kendiliğinden görünür; otomatik katılım
              açıkken bot, toplantı başladığında katılır.
            </span>
            <button style={cta} onClick={() => setModal(true)}>Takvimi bağla →</button>
          </div>
        )}
        <div style={cardBase}>
          <span style={cardTitle}><Icon name="plus" size={14} /> Toplantı planla</span>
          <span style={cardBody}>Tek bir toplantıyı elle oluşturun — başlık, saat, Meet bağlantısı. İlk deneme için ideal.</span>
          <button style={cta} onClick={() => plan()}>+ Toplantı planla</button>
        </div>
        {showJoin && <div style={cardBase}>
          <span style={cardTitle}><Icon name="send" size={14} /> Hemen bot gönder</span>
          <span style={cardBody}>Hâlihazırda devam eden bir toplantıya botu gönderin.</span>
          <JoinMeetingForm />
        </div>}
      </div>
      {connected === true && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--t3)" }}>
          ✓ Takvim bağlandı — zamanlanmış toplantılar eşitlendikçe burada görünür. Ayarlar → Takvim bölümünden başka takvimler ekleyebilirsiniz.
        </div>
      )}
      {modal && <ConnectCalendarModal onClose={() => setModal(false)} onConnected={reprobe} />}
    </>
  );
}
