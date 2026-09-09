"use client";
/** Calendar connections — the Settings → Calendar body (#1150 plural API).
 *
 *  An account holds up to ten NAMED ICS feeds, each with its own enabled flag, auto-join policy and
 *  bot name. This is the durable management surface: list · add · edit · disconnect · sync-one. The
 *  Meetings sidebar keeps its own first-connect card at the point of need (`meetingsOnboarding`).
 *
 *  Three rules this surface exists to hold:
 *
 *  1. **The feed address is write-only.** It goes out on create/replace and never comes back: the
 *     API returns `ics_url_set` plus a recognition mask, and no input here is ever PREFILLED from
 *     the server. Replacing a feed means typing a new one into an empty (masked) field.
 *  2. **Disconnect states its consequence before it fires.** Removing a connection disarms the
 *     meetings it alone imported — the row says so, in place, and needs a second click.
 *  3. **The ten-connection cap is a UI fact, not a surprise 409.** The count is always visible and
 *     Add is refused locally at the cap (the backend 409 stays the real gate, and still surfaces).
 *
 *  Sync is not automatic on the backend after a write, so the client runs it: after a create, and
 *  after any edit whose effect must be reconciled onto already-imported meetings (auto-join, bot
 *  name, enabled, a replaced feed). A rename alone changes nothing downstream, so it skips the sync.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Icon } from "../ui-kit";
import { presentError } from "./apiClient";
import { refreshMeetings } from "./liveMeetings";
import { defaultBotName } from "./defaultBotName";
import {
  MAX_CALENDARS, listCalendars, createCalendar, updateCalendar, deleteCalendar,
  syncCalendar, getCalendarSyncStatus,
  type CalendarConnection, type CalendarUpdateBody, type CalendarSyncStamp,
} from "./plannedApi";

const field: CSSProperties = { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "6px 9px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)" };
const btn: CSSProperties = { fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)", cursor: "pointer" };
const primaryBtn: CSSProperties = { ...btn, background: "var(--accent)", color: "var(--on-accent)", border: "none" };
const row: CSSProperties = { border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 };
const meta: CSSProperties = { fontSize: 11, color: "var(--t3)", lineHeight: 1.5 };
const labelled: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" };
const labelCol: CSSProperties = { width: 96, flex: "none", color: "var(--t3)" };
const checkRow: CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--t2)", cursor: "pointer" };

/** Which PATCH fields must be reconciled onto already-imported meetings by a follow-up sync.
 *  A rename is cosmetic on the connection alone — everything else changes what gets joined. */
export function patchNeedsSync(body: CalendarUpdateBody): boolean {
  return body.auto_join !== undefined || body.bot_name !== undefined
    || body.enabled !== undefined || body.ics_url !== undefined;
}

/** The one-line state of a connection's last sync attempt. `last_error` REPLACES the timestamp —
 *  a 200 carrying an error is a failed sync, not a successful one with a footnote. The stamp is
 *  formatted for the locale the app ships in, never the browser's default. */
export function syncLine(stamp: CalendarSyncStamp | undefined): { ok: boolean; text: string } {
  if (stamp?.last_error) return { ok: false, text: `Son eşitleme başarısız: ${stamp.last_error}` };
  if (!stamp?.last_sync) return { ok: true, text: "Henüz eşitlenmedi" };
  const c = stamp.counts;
  const counts = c
    ? ` · ${c.created ?? 0} içe aktarıldı, ${c.updated ?? 0} güncellendi${c.cancelled ? `, ${c.cancelled} iptal edildi` : ""}`
    : "";
  return { ok: true, text: `Son eşitleme: ${new Date(stamp.last_sync).toLocaleString("tr-TR")}${counts}` };
}

/** What the feed field says. The stored address is NEVER rendered; the mask (host + suffix) is a
 *  recognition hint the API hands out precisely because it is not the credential. */
export function feedLine(cal: CalendarConnection): string {
  if (!cal.ics_url_set) return "Akış tanımlı değil";
  return cal.ics_url_masked ? `Akış tanımlı · ${cal.ics_url_masked}` : "Akış tanımlı";
}

/** The consequence sentence, said BEFORE the destructive click — not after it. */
export function disconnectWarning(name: string): string {
  return `“${name}” bağlantısı kesilsin mi? Yalnızca bu takvimden içe aktarılan toplantılar Toplantılar listesinden kaldırılır ve bu toplantılara katılınmaz. Başka bir takvimden gelen ve elle planladığınız toplantılar kalır. Takvimin akış adresi silinir.`;
}

function EditPanel({ cal, busy, onSave, onCancel }: {
  cal: CalendarConnection;
  busy: boolean;
  onSave: (body: CalendarUpdateBody) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(cal.name);
  const [botName, setBotName] = useState(cal.bot_name ?? "");
  const [icsUrl, setIcsUrl] = useState("");   // always starts EMPTY — nothing stored is echoed back

  const body: CalendarUpdateBody = {};
  if (name.trim() && name.trim() !== cal.name) body.name = name.trim();
  if (botName.trim() && botName.trim() !== (cal.bot_name ?? "")) body.bot_name = botName.trim();
  if (icsUrl.trim()) body.ics_url = icsUrl.trim();
  const dirty = Object.keys(body).length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, borderTop: "1px dashed var(--line)", paddingTop: 9 }}>
      <label style={labelled}>
        <span style={labelCol}>Ad</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} style={field} aria-label={`${cal.name} için ad`} />
      </label>
      <label style={labelled}>
        <span style={labelCol}>Bot adı</span>
        <input value={botName} onChange={(e) => setBotName(e.target.value)} maxLength={100} placeholder={defaultBotName()}
          style={field} aria-label={`${cal.name} için bot adı`} />
      </label>
      <label style={labelled}>
        <span style={labelCol}>Akışı değiştir</span>
        <input value={icsUrl} onChange={(e) => setIcsUrl(e.target.value)} type="password" autoComplete="off"
          placeholder="değiştirmek için yeni bir gizli ICS adresi yapıştırın" style={field}
          aria-label={`${cal.name} için akış adresini değiştir`} />
      </label>
      <div style={{ ...meta, paddingLeft: 104 }}>
        Kayıtlı adres bir daha gösterilmez. Mevcut akışı korumak için burayı boş bırakın.
      </div>
      <div style={{ display: "flex", gap: 8, paddingLeft: 104 }}>
        <button disabled={busy || !dirty} onClick={() => onSave(body)}
          style={{ ...(dirty ? primaryBtn : btn), opacity: busy || !dirty ? 0.5 : 1 }}>
          {busy ? "Kaydediliyor…" : "Kaydet"}
        </button>
        <button disabled={busy} onClick={onCancel} style={btn}>İptal</button>
      </div>
    </div>
  );
}

function CalendarRow({ cal, stamp, busy, onPatch, onSync, onDisconnect }: {
  cal: CalendarConnection;
  stamp: CalendarSyncStamp | undefined;
  busy: string | null;
  onPatch: (body: CalendarUpdateBody) => void;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const locked = busy !== null;
  const sync = syncLine(stamp);

  return (
    <div style={{ ...row, opacity: cal.enabled ? 1 : 0.7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="cal" size={13} style={{ color: cal.enabled ? "var(--green)" : "var(--t3)" }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--t1)" }}>{cal.name}</span>
        <span style={{ flex: 1, fontSize: 11.5, color: "var(--t3)", fontFamily: "var(--mono)" }}>{feedLine(cal)}</span>
        <button disabled={locked} onClick={onSync} style={btn}>{busy === "sync" ? "Eşitleniyor…" : "Şimdi eşitle"}</button>
        <button disabled={locked} onClick={() => { setEditing((v) => !v); setConfirming(false); }}
          aria-expanded={editing} style={btn}>{editing ? "Kapat" : "Düzenle"}</button>
        <button disabled={locked} onClick={() => { setConfirming(true); setEditing(false); }}
          style={{ ...btn, color: "var(--danger)" }}>Bağlantıyı kes</button>
      </div>

      <div style={{ ...sync.ok ? meta : { ...meta, color: "var(--danger)" } }} role={sync.ok ? undefined : "alert"}>
        {sync.ok ? "" : "⚠ "}{sync.text}
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        <label style={checkRow}>
          <input type="checkbox" checked={cal.enabled} disabled={locked}
            onChange={(e) => onPatch({ enabled: e.target.checked })} />
          Etkin — yeni toplantılar için bu akış kontrol edilmeye devam etsin
        </label>
        <label style={checkRow}>
          <input type="checkbox" checked={cal.auto_join} disabled={locked}
            onChange={(e) => onPatch({ auto_join: e.target.checked })} />
          Otomatik katılım — botu bu takvimdeki toplantılara gönder
        </label>
        <span style={meta}>Bot adı <span style={{ color: "var(--t2)", fontFamily: "var(--mono)" }}>{cal.bot_name || defaultBotName()}</span></span>
      </div>

      {confirming && (
        <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 7, borderTop: "1px dashed var(--line)", paddingTop: 9 }}>
          <span style={{ fontSize: 11.5, color: "var(--danger)", lineHeight: 1.5 }}>⚠ {disconnectWarning(cal.name)}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={locked} onClick={onDisconnect}
              style={{ ...btn, background: "var(--danger)", color: "var(--on-accent)", border: "none", opacity: locked ? 0.5 : 1 }}>
              {busy === "delete" ? "Bağlantı kesiliyor…" : "Evet, bağlantıyı kes"}
            </button>
            <button disabled={locked} onClick={() => setConfirming(false)} style={btn}>Kalsın</button>
          </div>
        </div>
      )}

      {editing && (
        <EditPanel cal={cal} busy={busy === "update"}
          onSave={(body) => { onPatch(body); setEditing(false); }}
          onCancel={() => setEditing(false)} />
      )}
    </div>
  );
}

function AddCalendarForm({ busy, onAdd, onCancel }: {
  busy: boolean;
  onAdd: (body: { name: string; ics_url: string; auto_join: boolean; bot_name?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [icsUrl, setIcsUrl] = useState("");
  const [botName, setBotName] = useState("");
  const [autoJoin, setAutoJoin] = useState(true);
  const ready = !!name.trim() && !!icsUrl.trim();

  return (
    <div style={{ ...row, borderStyle: "dashed" }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--t1)" }}>Takvim ekleyin</div>
      <div style={meta}>
        Google Calendar: ⚙ Ayarlar → takviminiz → <b style={{ color: "var(--t2)" }}>Takvimi entegre et</b> → <b style={{ color: "var(--t2)" }}>iCal biçimindeki gizli adresi</b> kopyalayın.
        Outlook: Ayarlar → Takvim → Paylaşılan takvimler → Takvim yayımla. Herkese açık sayfa veya yerleştirme
        bağlantısı değil — gizli adres bir paroladır.
      </div>
      <label style={labelled}>
        <span style={labelCol}>Ad</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="İş"
          style={field} aria-label="Takvim adı" />
      </label>
      <label style={labelled}>
        <span style={labelCol}>Gizli ICS</span>
        <input value={icsUrl} onChange={(e) => setIcsUrl(e.target.value)} type="password" autoComplete="off"
          placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" style={field} aria-label="Gizli ICS adresi"
          onKeyDown={(e) => { if (e.key === "Enter" && ready && !busy) onAdd({ name: name.trim(), ics_url: icsUrl.trim(), auto_join: autoJoin, bot_name: botName.trim() || undefined }); }} />
      </label>
      <label style={labelled}>
        <span style={labelCol}>Bot adı</span>
        <input value={botName} onChange={(e) => setBotName(e.target.value)} maxLength={100} placeholder={defaultBotName()}
          style={field} aria-label="Yeni takvim için bot adı" />
      </label>
      <label style={{ ...checkRow, paddingLeft: 104 }}>
        <input type="checkbox" checked={autoJoin} onChange={(e) => setAutoJoin(e.target.checked)} />
        Bu takvimden içe aktarılan toplantılara otomatik katıl
      </label>
      <div style={{ display: "flex", gap: 8, paddingLeft: 104 }}>
        <button disabled={busy || !ready}
          onClick={() => onAdd({ name: name.trim(), ics_url: icsUrl.trim(), auto_join: autoJoin, bot_name: botName.trim() || undefined })}
          style={{ ...primaryBtn, opacity: busy || !ready ? 0.5 : 1 }}>
          {busy ? "Bağlanıyor…" : "Bağlan"}
        </button>
        <button disabled={busy} onClick={onCancel} style={btn}>İptal</button>
      </div>
    </div>
  );
}

export function CalendarConnectionsPanel() {
  const [cals, setCals] = useState<CalendarConnection[] | null>(null);
  const [stamps, setStamps] = useState<Record<string, CalendarSyncStamp>>({});
  const [busy, setBusy] = useState<string | null>(null);   // "new" | "<id>:sync|update|delete"
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listCalendars();
      setCals(list); setErr(null);
      // One bad stamp must not blank the page — each probe is caught on its own.
      const pairs = await Promise.all(list.map(async (c) => {
        try { return [c.id, await getCalendarSyncStatus(c.id)] as const; }
        catch { return [c.id, {} as CalendarSyncStamp] as const; }
      }));
      setStamps(Object.fromEntries(pairs));
    } catch (e: unknown) {
      setCals([]); setErr(presentError(e).headline);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const atCap = (cals?.length ?? 0) >= MAX_CALENDARS;

  const add = async (body: { name: string; ics_url: string; auto_join: boolean; bot_name?: string }) => {
    setBusy("new"); setErr(null); setNote(null);
    try {
      const created = await createCalendar(body);
      // The backend does not sync on create — answer the user NOW instead of leaving a silent wait.
      let stamp: CalendarSyncStamp = {};
      try { stamp = await syncCalendar(created.id); }
      catch (e: unknown) { stamp = { last_error: presentError(e).headline }; }
      setStamps((s) => ({ ...s, [created.id]: stamp }));
      setAdding(false);
      setNote(stamp.last_error
        ? `“${created.name}” bağlandı, ancak ilk eşitlemesi tamamlanamadı.`
        : `“${created.name}” bağlandı — ${(stamp.counts?.created ?? 0) + (stamp.counts?.updated ?? 0)} yaklaşan toplantı içe aktarıldı.`);
      refreshMeetings();
      await refresh();
    } catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(null); }
  };

  const patch = async (cal: CalendarConnection, body: CalendarUpdateBody) => {
    setBusy(`${cal.id}:update`); setErr(null); setNote(null);
    try {
      await updateCalendar(cal.id, body);
      if (patchNeedsSync(body)) {
        // PATCH does not reconcile existing planned meetings; the follow-up sync does.
        try { setStamps((s) => ({ ...s, [cal.id]: {} })); const st = await syncCalendar(cal.id); setStamps((s) => ({ ...s, [cal.id]: st })); }
        catch (e: unknown) { setStamps((s) => ({ ...s, [cal.id]: { last_error: presentError(e).headline } })); }
        refreshMeetings();
      }
      await refresh();
    } catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(null); }
  };

  const sync = async (cal: CalendarConnection) => {
    setBusy(`${cal.id}:sync`); setErr(null); setNote(null);
    try { const st = await syncCalendar(cal.id); setStamps((s) => ({ ...s, [cal.id]: st })); refreshMeetings(); }
    catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(null); }
  };

  const disconnect = async (cal: CalendarConnection) => {
    setBusy(`${cal.id}:delete`); setErr(null); setNote(null);
    try {
      await deleteCalendar(cal.id);
      setNote(`“${cal.name}” bağlantısı kesildi.`);
      refreshMeetings();
      await refresh();
    } catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(null); }
  };

  const busyFor = (id: string): string | null => (busy?.startsWith(`${id}:`) ? busy.slice(id.length + 1) : busy ? "other" : null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
      <div style={{ ...meta, maxWidth: 460 }}>
        Bir takvimin gizli ICS akışını bağladığınızda o takvimdeki planlı toplantılar Toplantılar listesinde
        kendiliğinden görünür; otomatik katılım açıkken bot, toplantılar başladığında onlara katılır. Her
        takvimin kendi otomatik katılım tercihi ve bot adı vardır.
      </div>
      {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ {err}</div>}
      {note && <div role="status" style={{ fontSize: 11.5, color: "var(--green)" }}>✓ {note}</div>}

      {cals === null ? (
        <div style={meta}>Takvimler yükleniyor…</div>
      ) : cals.length === 0 ? (
        <div style={meta}>Henüz bağlı takvim yok.</div>
      ) : (
        <>
          <div style={{ fontSize: 11.5, color: "var(--t3)" }}>
            {cals.length} / {MAX_CALENDARS} takvim bağlı
          </div>
          {cals.map((c) => (
            <CalendarRow key={c.id} cal={c} stamp={stamps[c.id]} busy={busyFor(c.id)}
              onPatch={(b) => void patch(c, b)} onSync={() => void sync(c)} onDisconnect={() => void disconnect(c)} />
          ))}
        </>
      )}

      {adding ? (
        <AddCalendarForm busy={busy === "new"} onAdd={(b) => void add(b)} onCancel={() => setAdding(false)} />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button disabled={atCap || busy !== null} onClick={() => { setAdding(true); setNote(null); }}
            style={{ ...btn, opacity: atCap || busy !== null ? 0.5 : 1 }}>+ Takvim ekle</button>
          {atCap && (
            <span style={meta}>
              {MAX_CALENDARS} takvimin tamamı bağlı — yenisini eklemek için birinin bağlantısını kesin.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
