"use client";
/** Login gate. Polls /api/auth/me on mount; if unauthenticated, renders the sign-in page.
 *
 *  Layout — the İnnova corporate sign-in (`login.css`, scoped under `.innova-login`): a white page
 *  with two faint red radial gradients, a header carrying the white İnnova wordmark on its charcoal
 *  backing next to the "Kurumsal uygulamalar" label, and one compact centered card. The card reads
 *  app name · "Hoş geldiniz" · one-line intro · the form · a note · a divider · the alternate
 *  sign-in link. The route is always light regardless of the app theme.
 *
 *  Method order: when the deploy carries LDAP_* config the domain form is the card; the
 *  "Diğer giriş seçenekleri" link under the divider swaps to the other methods — OAuth buttons when
 *  configured, otherwise the direct email entry, a DEBUG path the server restricts to addresses
 *  containing "test" — and `?auth=email` opens them directly. Without LDAP the other methods are the
 *  card. Enabled OAuth providers are discovered from NextAuth's /api/auth/providers so a deploy with
 *  no OAuth creds simply hides the buttons.
 *
 *  FIRST RUN: /api/auth/instance says whether an admin exists. On a fresh instance the card becomes
 *  the one-time "claim this instance" screen — first sign-in becomes the admin — through whatever
 *  auth the deploy actually has. */
import { useEffect, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";

type Status = "checking" | "out" | "in";
type Providers = { google: boolean; microsoft: boolean };
type Method = "ldap" | "email";

const APP_NAME = "Toplantı Asistanı";
const SUITE_LABEL = "Kurumsal uygulamalar";

/** `?auth=email` opens the non-LDAP methods directly, without the link. */
function methodFromUrl(): Method {
  if (typeof window === "undefined") return "ldap";
  return new URLSearchParams(window.location.search).get("auth") === "email" ? "email" : "ldap";
}

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
  // Which method the card shows. LDAP unless the URL asks for the others; the links swap between them.
  const [method, setMethod] = useState<Method>(methodFromUrl);

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
    // First-run probe — {admin_exists:false} flips the card into the admin-claim variant.
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
  if (status === "checking") return <div className="innova-login" />; // the same white page, empty, until the probe answers

  const hasOAuth = providers.google || providers.microsoft;
  const claiming = !adminExists; // fresh instance → this sign-in claims the admin role
  const showLdap = ldapEnabled && method === "ldap";
  const switchMethod = (next: Method) => { setMethod(next); setError(null); };
  const callbackUrl = () => window.location.pathname + window.location.search;

  const errorBox = error && <p className="il-error" id="login-error" role="alert">{error}</p>;
  const submitLabel = (busy: boolean) =>
    busy ? "Giriş yapılıyor…" : claiming ? "Yönetici olarak giriş yap" : <>Giriş yap <span aria-hidden="true">→</span></>;

  return (
    <div className="innova-login">
      <header className="il-header">
        <div className="il-logo"><img src="/innova-logo-beyaz.svg" alt="İnnova" width={826} height={157} /></div>
        <span className="il-suite">{SUITE_LABEL}</span>
      </header>
      <main className="il-main">
        <section className="il-card" aria-labelledby="login-title">
          <p className="il-app"><span className="il-dot" aria-hidden="true" /><span>{APP_NAME}</span></p>
          <h1 id="login-title">{claiming ? "Kurulumu sahiplenin" : "Hoş geldiniz"}</h1>
          <p className="il-intro">
            {claiming
              ? "Bu kurulumda henüz yönetici yok. İlk giriş yapan kişi yönetici olur; modelleri, transkripsiyonu ve diğer kullanıcıları yapılandırabilir."
              : "Devam etmek için hesabınıza giriş yapın."}
          </p>

          {claiming && !hasOAuth && !ldapEnabled && (
            <p className="il-notice">
              ⚠ Test modu — OAuth yapılandırılmamış. Giriş yalnızca &ldquo;test&rdquo; içeren e-posta
              adresleriyle yapılabilir. Gerçek kimlik doğrulama için Google veya Microsoft OAuth kimlik
              bilgileri edinip bu kurulumun ortam değişkenlerine ekleyin (GOOGLE_CLIENT_ID/SECRET veya
              MICROSOFT_CLIENT_ID/SECRET).
            </p>
          )}

          {showLdap && (
            <>
              <form onSubmit={submitLdap}>
                <div className="il-field">
                  <label htmlFor="auth-username">Kullanıcı adı</label>
                  <input
                    id="auth-username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    value={ldapUser}
                    onChange={(e) => setLdapUser(e.target.value)}
                    placeholder="Kullanıcı adınızı girin"
                  />
                </div>
                <div className="il-field">
                  <label htmlFor="auth-password">Şifre</label>
                  <div className="il-input-wrap">
                    <input
                      id="auth-password"
                      name="password"
                      type={showPass ? "text" : "password"}
                      autoComplete="current-password"
                      required
                      value={ldapPass}
                      onChange={(e) => setLdapPass(e.target.value)}
                      placeholder="Şifrenizi girin"
                    />
                    <button
                      className="il-eye"
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      aria-label={showPass ? "Şifreyi gizle" : "Şifreyi göster"}
                      aria-pressed={showPass}
                      aria-controls="auth-password"
                    >
                      <EyeMark off={showPass} />
                    </button>
                  </div>
                </div>
                {errorBox}
                <button className="il-submit" type="submit" disabled={ldapSubmitting} aria-busy={ldapSubmitting || undefined}>
                  {submitLabel(ldapSubmitting)}
                </button>
                <p className="il-note">İnnova kullanıcı bilgilerinizle giriş yapın.</p>
              </form>
              <div className="il-alternative">
                <button className="il-link" type="button" onClick={() => switchMethod("email")}>Diğer giriş seçenekleri</button>
              </div>
            </>
          )}

          {!showLdap && (
            <>
              <div className="il-methods">
                {providers.google && (
                  <button type="button" className="il-provider" onClick={() => signIn("google", { callbackUrl: callbackUrl() })}>
                    <GoogleMark /> Google ile devam et
                  </button>
                )}
                {providers.microsoft && (
                  <button type="button" className="il-provider" onClick={() => signIn("microsoft", { callbackUrl: callbackUrl() })}>
                    <MicrosoftMark /> Microsoft ile devam et
                  </button>
                )}

                {hasOAuth && (
                  <div className="il-center">
                    <button type="button" className="il-link" onClick={() => setShowDebug((v) => !v)}>
                      {showDebug ? "Hata ayıklama girişini gizle" : "Hata ayıklama girişi"}
                    </button>
                  </div>
                )}

                {(!hasOAuth || showDebug) && (
                  <form onSubmit={submit}>
                    <div className="il-field">
                      <label htmlFor="auth-email">E-posta</label>
                      <input
                        id="auth-email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="E-posta adresinizi girin"
                        aria-describedby="auth-email-hint"
                      />
                      <p className="il-hint" id="auth-email-hint">
                        {claiming && !hasOAuth
                          ? "Test modu — adres “test” içermelidir."
                          : "Hata ayıklama girişi — adres “test” içermelidir."}
                      </p>
                    </div>
                    {errorBox}
                    <button className="il-submit" type="submit" disabled={submitting} aria-busy={submitting || undefined}>
                      {submitLabel(submitting)}
                    </button>
                  </form>
                )}
              </div>

              {ldapEnabled && (
                <div className="il-alternative">
                  <button className="il-link" type="button" onClick={() => switchMethod("ldap")}>LDAP ile devam et</button>
                </div>
              )}
            </>
          )}

          {claiming && (
            <p className="il-note">Bu ekran, bir yönetici belirlendikten sonra bir daha görünmez.</p>
          )}
        </section>
      </main>
      <footer className="il-footer">İnnova · {SUITE_LABEL}</footer>
    </div>
  );
}

/** Eye (show password) / eye with a slash (hide password). */
function EyeMark({ off }: { off: boolean }) {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx={12} cy={12} r={3} />
      {off && <path d="m4 4 16 16" />}
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
