"use client";
/** Hidden Kullanıcılar surface — see, create and manage the deployment's users, and read what
 *  each one actually consumed.
 *
 *  HIDDEN the same way the infra panel is: nothing registers at import time. The module probes
 *  `/api/admin/me` (server-verified admin identity — app/api/admin/gate.ts) and only a 200
 *  registers the list + tab. Every /api/admin/* route answers 404 for a non-admin, so the panel
 *  is invisible rather than merely forbidden.
 *
 *  There are no passwords in this deployment: identity comes from the IdP and access from bearer
 *  tokens, so the credential action offered here is revoke + re-mint, not a password reset.
 *
 *  Data: GET /api/admin/users · POST /api/admin/users · PATCH /api/admin/users/<id> ·
 *  GET /api/admin/users/<id>/usage · GET|POST /api/admin/users/<id>/tokens ·
 *  DELETE /api/admin/tokens/<tokenId>.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { registerList, registerTab } from "../contributions";
import { useService } from "../platform";
import { LayoutServiceId, type TabDescriptor } from "../workbench/layout";
import { meetingsOnly } from "../app/mode";

interface UserRow {
  id: number;
  email: string;
  name?: string | null;
  max_concurrent_bots: number;
  data?: Record<string, unknown>;
  created_at?: string | null;
}
interface Usage {
  user_id: number;
  email: string;
  window_days: number;
  meetings_total: number;
  meetings_completed: number;
  meetings_failed: number;
  meeting_minutes: number;
  transcription_segments: number;
  reports_recorded: number;
  max_concurrent_bots: number;
  active_now: number;
  last_meeting_at?: string | null;
  by_platform: Record<string, number>;
}
interface TokenInfo { id: number; token?: string; scopes?: string[]; name?: string | null; last_used_at?: string | null }

const PANEL: TabDescriptor = { id: "admin-users", title: "Kullanıcılar", kind: "adminUsers", params: {} };

const card: CSSProperties = {
  border: "1px solid var(--line2)", borderRadius: 8, padding: "10px 12px", background: "var(--panel2)",
};
const input: CSSProperties = {
  background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: 6,
  padding: "6px 8px", color: "var(--t1)", fontSize: 12, outline: "none",
};
const btn: CSSProperties = {
  background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 6,
  padding: "6px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer",
};
const ghost: CSSProperties = { ...btn, background: "transparent", color: "var(--t2)", border: "1px solid var(--line2)", fontWeight: 500 };
const td: CSSProperties = { padding: "6px 8px", fontSize: 12, color: "var(--t1)", borderBottom: "1px solid var(--line2)" };
const th: CSSProperties = { ...td, color: "var(--t3)", fontWeight: 500 };

function trDate(iso?: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return iso; }
}

/** Reads the error a route actually returned, so a 503 misconfiguration does not read as "boş liste". */
async function readError(r: Response): Promise<string> {
  const body = (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
  return body.error || body.detail || `İstek başarısız (${r.status})`;
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div style={{ ...card, minWidth: 128 }} title={hint}>
      <div style={{ fontSize: 11, color: "var(--t3)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "var(--t1)", marginTop: 2 }}>{value}</div>
    </div>
  );
}

function UsageView({ userId }: { userId: number }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    void fetch(`/api/admin/users/${userId}/usage?window_days=${days}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<Usage>;
      })
      .then((u) => { if (live) setUsage(u); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [userId, days]);

  if (err) return <div style={{ fontSize: 12, color: "var(--danger)" }}>{err}</div>;
  if (!usage) return <div style={{ fontSize: 12, color: "var(--t3)" }}>Kullanım verisi yükleniyor…</div>;

  const platforms = Object.entries(usage.by_platform);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--t3)" }}>Dönem:</span>
        {[7, 30, 90, 365].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            style={{ ...ghost, ...(days === d ? { color: "var(--t1)", borderColor: "var(--accent)" } : {}) }}>
            {d} gün
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Metric label="Toplantı" value={usage.meetings_total} />
        <Metric label="Toplam süre" value={`${usage.meeting_minutes} dk`} />
        <Metric label="Transkripsiyon" value={usage.transcription_segments} hint="Kaydedilen transkript parçası sayısı" />
        <Metric label="Rapor" value={usage.reports_recorded}
          hint="Toplantı kaydına işlenmiş rapor sayısı. Üretici bu bağlantıyı henüz yazmıyorsa 0 görünür — tahmin edilmez." />
        <Metric label="Tamamlanan" value={usage.meetings_completed} />
        <Metric label="Başarısız" value={usage.meetings_failed} />
        <Metric label="Kota" value={`${usage.active_now} / ${usage.max_concurrent_bots}`}
          hint="Şu anda etkin toplantı sayısı / eşzamanlı bot kotası" />
      </div>
      <div style={{ fontSize: 12, color: "var(--t3)" }}>
        Son toplantı: {trDate(usage.last_meeting_at)}
        {platforms.length > 0 && (
          <> · Platformlar: {platforms.map(([p, n]) => `${p} (${n})`).join(", ")}</>
        )}
      </div>
    </div>
  );
}

function TokensView({ userId }: { userId: number }) {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch(`/api/admin/users/${userId}/tokens`, { cache: "no-store" });
      if (!r.ok) throw new Error(await readError(r));
      setTokens((await r.json()) as TokenInfo[]);
    } catch (e) { setErr((e as Error).message); }
  }, [userId]);

  useEffect(() => { void load(); setMinted(null); }, [load]);

  const mint = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/users/${userId}/tokens`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["bot", "tx"] }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const t = (await r.json()) as TokenInfo;
      setMinted(t.token || null);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const revoke = async (tokenId: number) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/tokens/${tokenId}`, { method: "DELETE" });
      if (!r.ok && r.status !== 204) throw new Error(await readError(r));
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button style={btn} onClick={() => void mint()} disabled={busy}>Yeni anahtar üret</button>
        <span style={{ fontSize: 11, color: "var(--t3)" }}>
          Bu kurulumda parola yoktur — erişimi sıfırlamak, anahtarı iptal edip yenisini üretmektir.
        </span>
      </div>
      {minted && (
        <div style={{ ...card, borderColor: "var(--accent)" }}>
          <div style={{ fontSize: 11, color: "var(--t3)" }}>Yeni anahtar — yalnızca bir kez gösterilir:</div>
          <code style={{ fontSize: 12, color: "var(--t1)", wordBreak: "break-all" }}>{minted}</code>
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: "var(--danger)" }}>{err}</div>}
      {tokens && tokens.length === 0 && <div style={{ fontSize: 12, color: "var(--t3)" }}>Bu kullanıcının API anahtarı yok.</div>}
      {tokens && tokens.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><th style={th}>Kapsam</th><th style={th}>Son kullanım</th><th style={th} /></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td style={td}>{(t.scopes || []).join(", ") || "—"}</td>
                <td style={td}>{trDate(t.last_used_at)}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button style={ghost} onClick={() => void revoke(t.id)} disabled={busy}>İptal et</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function UserDetail({ user, onChanged }: { user: UserRow; onChanged: () => void }) {
  const [quota, setQuota] = useState(String(user.max_concurrent_bots));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setQuota(String(user.max_concurrent_bots)); setSaved(false); setErr(null); }, [user]);

  const save = async () => {
    const n = Number(quota);
    if (!Number.isInteger(n) || n < 0) { setErr("Kota negatif olmayan bir tam sayı olmalıdır."); return; }
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_concurrent_bots: n }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setSaved(true);
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 14px", overflowY: "auto" }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--t1)" }}>{user.email}</div>
        <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 2 }}>
          #{user.id} · kayıt: {trDate(user.created_at)}
          {user.data && (user.data as { is_admin?: boolean }).is_admin ? " · yönetici" : ""}
        </div>
      </div>

      <section>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)", marginBottom: 6 }}>Kullanım</div>
        <UsageView userId={user.id} />
      </section>

      <section>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)", marginBottom: 6 }}>Eşzamanlı bot kotası</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input style={{ ...input, width: 80 }} value={quota} inputMode="numeric"
            onChange={(e) => { setQuota(e.target.value); setSaved(false); }} />
          <button style={btn} onClick={() => void save()} disabled={saving}>{saving ? "Kaydediliyor…" : "Kaydet"}</button>
          {saved && <span style={{ fontSize: 11, color: "var(--t3)" }}>Kaydedildi.</span>}
        </div>
        {err && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{err}</div>}
      </section>

      <section>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)", marginBottom: 6 }}>API anahtarları</div>
        <TokensView userId={user.id} />
      </section>
    </div>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    const value = email.trim().toLowerCase();
    if (!value) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, max_concurrent_bots: 3 }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setEmail("");
      onCreated();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--line2)" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input style={{ ...input, flex: 1 }} placeholder="yeni-kullanici@sirket.com" value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
        <button style={btn} onClick={() => void create()} disabled={busy || !email.trim()}>Ekle</button>
      </div>
      {err && <div style={{ fontSize: 11, color: "var(--danger)" }}>{err}</div>}
    </div>
  );
}

function UsersPanel() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<UserRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch(`/api/admin/users?limit=200${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(await readError(r));
      const body = (await r.json()) as { items: UserRow[]; total: number };
      setUsers(body.items);
      setTotal(body.total);
      setSelected((cur) => (cur ? body.items.find((u) => u.id === cur.id) || cur : null));
    } catch (e) { setErr((e as Error).message); }
  }, [q]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div style={{ width: 280, borderRight: "1px solid var(--line2)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <CreateUser onCreated={() => void load()} />
        <div style={{ padding: "8px 10px" }}>
          <input style={{ ...input, width: "100%" }} placeholder="E-posta veya ad ara…" value={q}
            onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {err && <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--danger)" }}>{err}</div>}
          {users && users.length === 0 && !err && (
            <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--t3)" }}>Kullanıcı bulunamadı.</div>
          )}
          {(users || []).map((u) => (
            <button key={u.id} onClick={() => setSelected(u)}
              style={{
                display: "block", width: "100%", textAlign: "left", background: selected?.id === u.id ? "var(--panel2)" : "transparent",
                border: "none", borderBottom: "1px solid var(--line2)", padding: "8px 10px", cursor: "pointer", color: "var(--t1)",
              }}>
              <div style={{ fontSize: 12 }}>{u.email}</div>
              <div style={{ fontSize: 10.5, color: "var(--t3)", marginTop: 2 }}>
                #{u.id} · kota {u.max_concurrent_bots}
              </div>
            </button>
          ))}
        </div>
        <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--t3)", borderTop: "1px solid var(--line2)" }}>
          {total} kullanıcı
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {selected
          ? <UserDetail user={selected} onChanged={() => void load()} />
          : <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--t3)" }}>
              Ayrıntıları ve kullanım bilgilerini görmek için soldan bir kullanıcı seçin.
            </div>}
      </div>
    </div>
  );
}

function UsersLeft() {
  const layout = useService(LayoutServiceId);
  useEffect(() => { layout.openTab(PANEL); }, [layout]);
  return (
    <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--t3)" }}>
      Kullanıcıları görün, ekleyin, kotalarını düzenleyin, API anahtarlarını yönetin ve hizmet
      kullanımlarını izleyin.
    </div>
  );
}

// Registers only after the server confirms an admin identity (404 for everyone else — see
// app/api/admin/*). Absent in meetings-only mode, like the other agent surfaces.
if (!meetingsOnly() && typeof window !== "undefined") {
  void fetch("/api/admin/me", { cache: "no-store" })
    .then((r) => {
      if (!r.ok) return;
      registerTab("adminUsers", UsersPanel);
      registerList({ id: "adminUsers", label: "Kullanıcılar", icon: "users", order: 91, component: UsersLeft });
    })
    .catch(() => { /* hidden — a failed probe just means no entry */ });
}
