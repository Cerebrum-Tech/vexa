"use client";
/** Settings — the footer-gear CENTER tab (design-spec meeting-lifecycle-v2, W5): account-level
 *  configuration in one place — Calendar integration, API tokens, GitHub token, Account. The old
 *  "API Tokens" activity-bar item retired into here (its panels are imported, not duplicated);
 *  the Meetings sidebar keeps its own first-connect calendar card at the point of need — this is
 *  the durable home (multi-calendar management lives in `calendarConnections.tsx`). Sections are a left nav (no sub-routing; one tab, local state). */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { registerTab } from "../contributions";
import { Icon } from "../ui-kit";
import { GitHubTokenCard, TokensPanel } from "./tokens";
import { presentError } from "./apiClient";
import { CalendarConnectionsPanel } from "./calendarConnections";
import { getModelPrefs, setModelPrefs, getTranscriptionPrefs, setTranscriptionPrefs, getGlobalSetting, setGlobalSetting, testModels, testTranscription, type ConfigTestResult } from "./settingsApi";

type SectionId = "calendar" | "models" | "tokens" | "github" | "account";
const SECTIONS: Array<{ id: SectionId; label: string; icon: string }> = [
  { id: "calendar", label: "Takvim", icon: "cal" },
  { id: "models", label: "Teknik ayarlar", icon: "spark" },
  { id: "tokens", label: "API anahtarları", icon: "key" },
  { id: "github", label: "GitHub", icon: "github" },
  { id: "account", label: "Hesap", icon: "user" },
];

const field: CSSProperties = { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "6px 9px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)" };
const btn: CSSProperties = { fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)", cursor: "pointer" };

/** One models/transcription config form — the SAME fields serve the per-user prefs and (for
 *  admins) the global platform defaults; only load/save differ. Secrets arrive MASKED
 *  (********abcd): an untouched masked value is never sent back, typing replaces it, emptying a
 *  previously-set field clears it (empty string = clear, the API's contract). */
function ConfigForm({ fields, load, save, note }: {
  fields: Array<{ key: string; label: string; placeholder?: string; secret?: boolean; options?: Array<{ value: string; label: string }>; showIf?: (v: Record<string, string>) => boolean }>;
  load: () => Promise<Record<string, string>>;
  save: (update: Record<string, string>) => Promise<Record<string, string>>;
  note?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let on = true;
    load().then((v) => { if (on) { setValues(v); setInitial(v); } })
      .catch((e: unknown) => on && setErr(presentError(e).headline));
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = fields.some((f) => (values[f.key] ?? "") !== (initial[f.key] ?? ""));
  const doSave = async () => {
    setBusy(true); setErr(null); setSaved(false);
    // Send only what changed; an untouched masked secret stays server-side.
    const update: Record<string, string> = {};
    for (const f of fields) {
      if ((values[f.key] ?? "") !== (initial[f.key] ?? "")) update[f.key] = values[f.key] ?? "";
    }
    try { const v = await save(update); setValues(v); setInitial(v); setSaved(true); }
    catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 }}>
      {note && <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.5 }}>{note}</div>}
      {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ {err}</div>}
      {fields.map((f) => (f.showIf && !f.showIf(values)) ? null : (
        <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
          <span style={{ width: 110, flex: "none", color: "var(--t3)" }}>{f.label}</span>
          {f.options ? (
            <select value={values[f.key] ?? ""}
              onChange={(e) => { setSaved(false); setValues((v) => ({ ...v, [f.key]: e.target.value })); }}
              style={{ ...field, width: "auto", flex: 1 }}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input value={values[f.key] ?? ""} placeholder={f.placeholder}
              type={f.secret && (values[f.key] ?? "") !== (initial[f.key] ?? "") ? "password" : "text"}
              onChange={(e) => { setSaved(false); setValues((v) => ({ ...v, [f.key]: e.target.value })); }}
              style={field} />
          )}
        </label>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button disabled={busy || !dirty} onClick={() => void doSave()}
          style={{ ...btn, background: dirty ? "var(--accent)" : "var(--panel2)", color: dirty ? "var(--on-accent)" : "var(--t3)", border: dirty ? "none" : btn.border, opacity: busy ? 0.5 : 1 }}>
          {busy ? "Kaydediliyor…" : "Kaydet"}
        </button>
        {saved && <span style={{ fontSize: 11.5, color: "var(--green)" }}>Kaydedildi — asistanın bir sonraki yanıtında kullanılacak</span>}
      </div>
    </div>
  );
}

/** The verdict badge names WHAT was tested in the reader’s own vocabulary: `mode` and `source`
 *  are protocol tokens, mapped to the same words the provider select offers before they reach the
 *  screen. An unmapped token still renders — never swallow a value the backend added. */
const MODE_LABELS: Record<string, string> = { subscription: "Claude aboneliği", custom: "özel uç nokta" };
const SOURCE_LABELS: Record<string, string> = { settings: "ayarlardan", env: "ortam değişkeninden", global: "genel ayarlardan" };

/** On-demand credential test row (fail-loud surface): runs the EFFECTIVE config — the same
 *  user > global > env resolution a chat turn / bot spawn applies — against the real backend
 *  and prints the verdict inline, remedy included. What Save can't tell you, Test does. */
function TestRow({ label, run }: { label: string; run: () => Promise<ConfigTestResult> }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ConfigTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const doTest = async () => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await run()); }
    catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };
  const provenance = res
    ? [res.mode && (MODE_LABELS[res.mode] ?? res.mode),
       res.source && (SOURCE_LABELS[res.source] ?? `${res.source} üzerinden`)].filter(Boolean).join(" · ")
    : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 460, marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button disabled={busy} onClick={() => void doTest()}
          style={{ ...btn, opacity: busy ? 0.5 : 1 }}>
          {busy ? "Test ediliyor…" : label}
        </button>
        {res && (
          <span style={{ fontSize: 11.5, color: res.ok ? "var(--green)" : "var(--danger)" }}>
            {res.ok ? "✓" : "✗"} {provenance && <span style={{ color: "var(--t3)" }}>[{provenance}] </span>}
            {res.summary}
          </span>
        )}
        {err && <span role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ test başarısız: {err}</span>}
      </div>
    </div>
  );
}

/** Models — which LLM the agent runs on and which STT backend the bot transcribes with; your own
 *  settings first, the deployment-wide defaults below for admins. Empty fields = the level below
 *  decides (global settings, then the deployment env). */
function ModelsSection() {
  const [globalAdmin, setGlobalAdmin] = useState(false);
  useEffect(() => {
    let on = true;
    // Admin probe: the global card renders only when /api/admin/settings answers (404 = not admin).
    getGlobalSetting("models").then((v) => on && setGlobalAdmin(v !== null)).catch(() => undefined);
    return () => { on = false; };
  }, []);

  const modelFields = [
    { key: "mode", label: "Sağlayıcı", options: [
      { value: "", label: "Dağıtım varsayılanı" },
      { value: "subscription", label: "Claude aboneliği (dağıtım kimlik bilgileri)" },
      { value: "custom", label: "Yerel model / özel uç nokta" },
    ] },
    { key: "base_url", label: "Temel adres", placeholder: "https://… (Anthropic/OpenAI uyumlu ağ geçidi)", showIf: (v: Record<string, string>) => v.mode === "custom" },
    { key: "api_key", label: "API anahtarı", placeholder: "yazmadıkça değişmez", secret: true, showIf: (v: Record<string, string>) => v.mode === "custom" },
    { key: "model", label: "Sohbet modeli", placeholder: "dağıtım varsayılanı (ör. sonnet)" },
    { key: "meeting_model", label: "Toplantı modeli", placeholder: "varsayılan olarak sohbet modeli" },
  ];
  const transcriptionFields = [
    { key: "url", label: "Hizmet adresi", placeholder: "kurulum varsayılanı" },
    { key: "token", label: "Belirteç", placeholder: "yazmadıkça değişmez", secret: true },
  ];
  const asStrings = (v: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string" && val) out[k] = val;
    return out;
  };
  const head: CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--t1)", margin: "14px 0 6px" };

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.5, marginBottom: 12, maxWidth: 460 }}>
        Asistanın hangi model üzerinde çalıştığını ve toplantı botlarının hangi transkripsiyon
        hizmetini kullandığını burada belirlersiniz. &ldquo;Claude aboneliği&rdquo; sağlayıcısı dağıtımın
        Claude kimlik bilgilerini kullanır; &ldquo;Yerel model / özel uç nokta&rdquo; kendi
        Anthropic/OpenAI uyumlu uç noktanızı işaret eder (bir LiteLLM/OpenRouter ağ geçidi açık
        kaynak modelleri sunar). Boş bırakılan alanlar dağıtım varsayılanlarını devralır.
      </div>
      <div style={head}>Modelleriniz</div>
      <ConfigForm fields={modelFields} load={async () => asStrings(await getModelPrefs())}
        save={async (u) => asStrings(await setModelPrefs(u))} />
      <TestRow label="Bağlantıyı test et" run={testModels} />
      <div style={head}>Transkripsiyon arka ucunuz</div>
      <ConfigForm fields={transcriptionFields} load={async () => asStrings(await getTranscriptionPrefs())}
        save={async (u) => asStrings(await setTranscriptionPrefs(u))} />
      <TestRow label="Transkripsiyon bağlantısını test et" run={testTranscription} />
      {globalAdmin && <>
        <div style={{ ...head, marginTop: 22, color: "var(--accent)" }}>Genel varsayılanlar (yönetici — kendi ayarı olmayan tüm kullanıcılar)</div>
        <ConfigForm fields={modelFields} load={async () => (await getGlobalSetting("models")) ?? {}}
          save={(u) => setGlobalSetting("models", u)} />
        <div style={head}>Genel transkripsiyon arka ucu</div>
        <ConfigForm fields={transcriptionFields} load={async () => (await getGlobalSetting("transcription")) ?? {}}
          save={(u) => setGlobalSetting("transcription", u)} />
      </>}
    </div>
  );
}

function AccountSection() {
  const [user, setUser] = useState<{ email?: string | null; name?: string | null } | null>(null);
  useEffect(() => {
    let on = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => on && setUser((d?.user as { email?: string; name?: string } | undefined) ?? null))
      .catch(() => undefined);
    return () => { on = false; };
  }, []);
  return (
    <div style={{ fontSize: 12.5, color: "var(--t2)", lineHeight: 1.9 }}>
      <div><span style={{ color: "var(--t3)" }}>Giriş yapılan hesap</span> <span style={{ color: "var(--t1)" }}>{user?.name || user?.email || "…"}</span></div>
      {user?.email && <div><span style={{ color: "var(--t3)" }}>E-posta</span> <span style={{ fontFamily: "var(--mono)" }}>{user.email}</span></div>}
      <div style={{ color: "var(--t3)", marginTop: 6 }}>Temayı üst menüden değiştirebilir, sol menüdeki hesabınızdan çıkış yapabilirsiniz.</div>
    </div>
  );
}

function SettingsView() {
  const [section, setSection] = useState<SectionId>("calendar");
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/admin/me", { cache: "no-store" }).then((r) => { if (alive) setAdmin(r.ok); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const sections = SECTIONS.filter((s) => admin || s.id === "calendar" || s.id === "account");
  const bodies: Record<SectionId, ReactNode> = {
    calendar: <CalendarConnectionsPanel />,
    models: <ModelsSection />,
    tokens: <TokensPanel />,
    github: <GitHubTokenCard />,
    account: <AccountSection />,
  };
  return (
    <div className="workspace-settings" style={{ height: "100%", display: "flex", minHeight: 0 }}>
      <div style={{ width: 160, flex: "none", borderRight: "1px solid var(--line)", padding: "14px 8px", background: "var(--sidebar)" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--t1)", padding: "0 8px 10px" }}>Ayarlar</div>
        {sections.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)}
            style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", fontSize: 12.5,
              padding: "6px 9px", borderRadius: 7, border: "none", cursor: "pointer",
              color: section === s.id ? "var(--t1)" : "var(--t2)", background: section === s.id ? "var(--panel2)" : "transparent" }}>
            <Icon name={s.icon} size={13} />{s.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px", minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--t1)", marginBottom: 12 }}>
          {SECTIONS.find((s) => s.id === section)?.label}
        </div>
        {bodies[section]}
      </div>
    </div>
  );
}

registerTab("settings", SettingsView);
