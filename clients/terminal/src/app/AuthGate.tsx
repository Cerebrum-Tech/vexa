"use client";
/** Login gate. Polls /api/auth/me on mount; if unauthenticated, renders the sign-in page.
 *
 *  Layout: one centered column on the page background — a large heading naming the service and the
 *  method, stacked "label over field" inputs with no box around them, a full-width pill button, and a
 *  single underlined text link for the alternative method beneath it. No card, no logo row.
 *
 *  Method order: when the deploy carries LDAP_* config the domain form is the page and
 *  "E-posta ile devam et" swaps it for the other methods (OAuth buttons when configured, otherwise the
 *  direct email entry — a DEBUG path the server restricts to addresses containing "test"). Without
 *  LDAP the other methods are the page. Enabled OAuth providers are discovered from NextAuth's
 *  /api/auth/providers so a deploy with no OAuth creds simply hides the buttons.
 *
 *  FIRST RUN: /api/auth/instance says whether an admin exists. On a fresh instance the page becomes
 *  the one-time "claim this instance" screen — first sign-in becomes the admin — through whatever
 *  auth the deploy actually has. Colors come from the globals.css tokens so both themes work. */
import { useEffect, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";

type Status = "checking" | "out" | "in";
type Providers = { google: boolean; microsoft: boolean };
type Method = "ldap" | "email";

const SERVICE_NAME = "İnnova Toplantı Asistanı";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [providers, setProviders] = useState<Providers>({ google: false, microsoft: false });
  const [adminExists, setAdminExists] = useState(true); // fail-safe: plain sign-in until told otherwise
  const [showDebug, setShowDebug] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Domain (LDAP/Active Directory) sign-in — the probe flips this on when LDAP_* is configured.
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const [ldapUser, setLdapUser] = useState("");
  const [ldapPass, setLdapPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [ldapSubmitting, setLdapSubmitting] = useState(false);
  // Which method the page currently shows; the link under the button swaps between the two.
  const [method, setMethod] = useState<Method>("ldap");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (active ? setStatus(r.ok ? "in" : "out") : undefined))
      .catch(() => active && setStatus("out"));
    // NextAuth lists configured providers here; absent/failed → just no OAuth buttons.
    fetch("/api/auth/providers", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((p: Record<string, unknown>) =>
        active && setProviders({ google: !!p.google, microsoft: !!p.microsoft }))
      .catch(() => undefined);
    // First-run probe — {admin_exists:false} flips the page into the admin-claim variant.
    fetch("/api/auth/instance", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { admin_exists: true }))
      .then((d: { admin_exists?: boolean }) => active && setAdminExists(d.admin_exists !== false))
      .catch(() => undefined);
    // Domain sign-in probe — {enabled:true} when the deploy carries LDAP_* config.
    fetch("/api/auth/ldap", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d: { enabled?: boolean }) => active && setLdapEnabled(d.enabled === true))
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      if (r.ok) { window.location.reload(); return; }
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error || `Giriş yapılamadı (${r.status})`);
    } catch (err) {
      setError((err as Error).message || "Giriş yapılamadı");
    } finally {
      setSubmitting(false);
    }
  };

  const submitLdap = async (e: FormEvent) => {
    e.preventDefault();
    const username = ldapUser.trim();
    if (!username || !ldapPass || ldapSubmitting) return;
    setLdapSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/ldap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: ldapPass }),
      });
      if (r.ok) { window.location.reload(); return; }
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error || `Giriş yapılamadı (${r.status})`);
    } catch (err) {
      setError((err as Error).message || "Giriş yapılamadı");
    } finally {
      // Never keep the password in memory after an attempt.
      setLdapPass("");
      setLdapSubmitting(false);
    }
  };

  if (status === "in") return <>{children}</>;
  if (status === "checking") return <div style={{ height: "100vh", background: "var(--bg)" }} />;

  const hasOAuth = providers.google || providers.microsoft;
  const claiming = !adminExists; // fresh instance → this sign-in claims the admin role
  const showLdap = ldapEnabled && method === "ldap";
  const switchMethod = (next: Method) => { setMethod(next); setError(null); };

  const heading = claiming
    ? `${SERVICE_NAME} kurulumunu sahiplenin`
    : showLdap
      ? `${SERVICE_NAME}'na LDAP ile giriş yapın`
      : `${SERVICE_NAME}'na giriş yapın`;

  return (
    <div className="auth-screen" style={{ minHeight: "100dvh", background: "var(--bg)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "clamp(48px, 12vh, 140px) 24px 48px" }}>
      <div style={{ width: 560, maxWidth: "100%", display: "flex", flexDirection: "column", gap: 28 }}>
        <h1 style={{ margin: 0, fontSize: "clamp(28px, 5vw, 40px)", lineHeight: 1.2, fontWeight: 500, letterSpacing: "-0.02em", color: "var(--t1)", textAlign: "center", textWrap: "balance" }}>
          {heading}
        </h1>

        {claiming && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "center" }}>
            <div style={{ fontSize: 14, color: "var(--t2)", lineHeight: 1.5 }}>
              Bu kurulumda henüz yönetici yok. İlk giriş yapan kişi yönetici olur; modelleri,
              transkripsiyonu ve diğer kullanıcıları yapılandırabilir.
            </div>
            {!hasOAuth && !ldapEnabled && (
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--t2)", background: "var(--panel2)", borderRadius: 10, padding: "10px 14px", textAlign: "left" }}>
                ⚠ Test modu — OAuth yapılandırılmamış. Giriş yalnızca &ldquo;test&rdquo; içeren e-posta
                adresleriyle yapılabilir. Gerçek kimlik doğrulama için Google veya Microsoft OAuth kimlik
                bilgileri edinip bu kurulumun ortam değişkenlerine ekleyin (GOOGLE_CLIENT_ID/SECRET veya
                MICROSOFT_CLIENT_ID/SECRET).
              </div>
            )}
          </div>
        )}

        {showLdap && (
          <form onSubmit={submitLdap} style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={fieldStyle}>
              <label htmlFor="auth-username" style={labelStyle}>Kullanıcı Adı</label>
              <input
                id="auth-username"
                type="text"
                autoComplete="username"
                required
                autoFocus
                value={ldapUser}
                onChange={(e) => setLdapUser(e.target.value)}
                placeholder="Kullanıcı adınızı girin"
                style={inputStyle}
              />
            </div>
            <div style={fieldStyle}>
              <label htmlFor="auth-password" style={labelStyle}>Şifre</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="auth-password"
                  type={showPass ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={ldapPass}
                  onChange={(e) => setLdapPass(e.target.value)}
                  placeholder="Şifrenizi girin"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  aria-label={showPass ? "Şifreyi gizle" : "Şifreyi göster"}
                  aria-pressed={showPass}
                  style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: "var(--t1)", display: "inline-flex" }}
                >
                  <EyeMark off={showPass} />
                </button>
              </div>
            </div>
            {error && <div style={errorStyle}>{error}</div>}
            <button type="submit" disabled={!ldapUser.trim() || !ldapPass || ldapSubmitting} style={pillBtn(!!ldapUser.trim() && !!ldapPass && !ldapSubmitting)}>
              {ldapSubmitting ? "Doğrulanıyor…" : claiming ? "Yönetici olarak doğrula" : "Kimlik Doğrula"}
            </button>
            <button type="button" onClick={() => switchMethod("email")} style={textLink}>
              E-posta ile devam et
            </button>
          </form>
        )}

        {!showLdap && (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            {providers.google && (
              <button onClick={() => signIn("google", { callbackUrl: window.location.pathname + window.location.search })} style={pillBtn(true)}>
                <GoogleMark /> Google ile devam et
              </button>
            )}
            {providers.microsoft && (
              <button onClick={() => signIn("microsoft", { callbackUrl: window.location.pathname + window.location.search })} style={pillBtn(true)}>
                <MicrosoftMark /> Microsoft ile devam et
              </button>
            )}

            {hasOAuth && (
              <button onClick={() => setShowDebug((v) => !v)} style={textLink}>
                {showDebug ? "Hata ayıklama girişini gizle" : "Hata ayıklama girişi"}
              </button>
            )}

            {(!hasOAuth || showDebug) && (
              <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 22 }}>
                <div style={fieldStyle}>
                  <label htmlFor="auth-email" style={labelStyle}>E-posta</label>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    autoFocus={!hasOAuth}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="E-posta adresinizi girin"
                    style={inputStyle}
                  />
                  <span style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.4 }}>
                    {claiming && !hasOAuth
                      ? "Test modu — adres “test” içermelidir."
                      : "Hata ayıklama girişi — adres “test” içermelidir."}
                  </span>
                </div>
                {error && <div style={errorStyle}>{error}</div>}
                <button type="submit" disabled={!email.trim() || submitting} style={pillBtn(!!email.trim() && !submitting)}>
                  {submitting ? "Giriş yapılıyor…" : claiming ? "Yönetici olarak giriş yap" : "Giriş yap"}
                </button>
              </form>
            )}

            {ldapEnabled && (
              <button type="button" onClick={() => switchMethod("ldap")} style={textLink}>
                LDAP ile devam et
              </button>
            )}
          </div>
        )}

        {claiming && (
          <div style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.4, textAlign: "center" }}>
            Bu ekran, bir yönetici belirlendikten sonra bir daha görünmez.
          </div>
        )}
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const labelStyle: React.CSSProperties = { fontSize: 18, fontWeight: 500, color: "var(--t1)" };
const inputStyle: React.CSSProperties = {
  background: "transparent", border: "none", borderRadius: 0, padding: "6px 0",
  color: "var(--t1)", fontSize: 20, outline: "none", width: "100%",
};
const errorStyle: React.CSSProperties = { fontSize: 13, color: "var(--danger)", lineHeight: 1.4 };
const textLink: React.CSSProperties = {
  background: "none", border: "none", padding: 0, alignSelf: "center", cursor: "pointer",
  color: "var(--t1)", fontSize: 16, textDecoration: "underline", textUnderlineOffset: 3,
};
/** Full-width pill. Enabled: primary accent. Idle (nothing typed yet): the quiet panel tone. */
function pillBtn(enabled: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 10, width: "100%",
    background: enabled ? "var(--accent)" : "var(--panel2)",
    color: enabled ? "var(--on-accent)" : "var(--t2)",
    border: "none", borderRadius: 999, padding: "16px 20px", fontSize: 18, fontWeight: 500,
    cursor: enabled ? "pointer" : "default",
  };
}

/** Eye (show password) / eye with a slash (hide password). */
function EyeMark({ off }: { off: boolean }) {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx={12} cy={12} r={3} />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

/** Google's multicolor "G" brand mark. */
function GoogleMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 48 48" style={{ flex: "none" }} aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Microsoft's four-square brand mark. */
function MicrosoftMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 23 23" style={{ flex: "none" }} aria-hidden="true">
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M12 1h10v10H12z" />
      <path fill="#00A4EF" d="M1 12h10v10H1z" />
      <path fill="#FFB900" d="M12 12h10v10H12z" />
    </svg>
  );
}
