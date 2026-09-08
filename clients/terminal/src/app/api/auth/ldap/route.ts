/** Domain (LDAP/Active Directory) login. POST {username, password} → bind-search-bind against the
 *  corporate directory → resolve the account's email + display name → find-or-create the Vexa user at
 *  admin-api and mint an APIToken (scopes bot,tx,browser) → set the httpOnly `vexa-token` +
 *  `vexa-user-info` cookies, exactly like the email path. GET → {enabled} so the login card knows
 *  whether to render the domain form.
 *
 *  The directory proves the password; this route never stores it and never logs it. Must never be
 *  cached — a cached response would pin one identity for every subsequent login.
 */
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, USER_INFO_COOKIE, findOrCreateUserToken } from "../adminApi";
import {
  authenticateWithLdap,
  isLdapEnabled,
  LdapAuthError,
  resolveLdapDisplayName,
  resolveLdapEmail,
} from "@/lib/ldap";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

function isSecureRequest(): boolean {
  return (
    (process.env.TERMINAL_URL || "").startsWith("https://") ||
    (process.env.NEXTAUTH_URL || "").startsWith("https://") ||
    false
  );
}

export async function GET() {
  return NextResponse.json({ enabled: isLdapEnabled() }, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "İstek okunamadı — lütfen tekrar deneyin." }, { status: 400, headers: NO_STORE });
  }

  const { username, password } = body;
  if (typeof username !== "string" || !username.trim()) {
    return NextResponse.json({ error: "Kullanıcı adı gerekli." }, { status: 400, headers: NO_STORE });
  }
  if (typeof password !== "string" || !password) {
    return NextResponse.json({ error: "Şifre gerekli." }, { status: 400, headers: NO_STORE });
  }

  let profile;
  try {
    profile = await authenticateWithLdap(username, password);
  } catch (err) {
    if (err instanceof LdapAuthError) {
      // `reason` stays server-side; only the safe message reaches the client.
      console.warn(`[LDAP] giriş reddedildi (${err.reason})`);
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    console.error("[LDAP] beklenmeyen hata", err);
    return NextResponse.json({ error: "Giriş yapılamadı — lütfen daha sonra tekrar deneyin." }, { status: 500, headers: NO_STORE });
  }

  const email = resolveLdapEmail(profile);
  if (!email) {
    // The account authenticated but carries no email and no LDAP_EMAIL_DOMAIN is set to derive one.
    console.error("[LDAP] doğrulanan hesap için e-posta çözümlenemedi; LDAP_EMAIL_DOMAIN ayarlayın");
    return NextResponse.json(
      { error: "Hesabınız için e-posta adresi bulunamadı. Lütfen BT ile iletişime geçin." },
      { status: 422, headers: NO_STORE },
    );
  }
  const name = resolveLdapDisplayName(profile, email.split("@")[0]);

  const result = await findOrCreateUserToken(email, name);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status || 500, headers: NO_STORE });
  }

  const { user, token } = result;
  const secure = isSecureRequest();
  const cookieStore = await cookies();
  const opts = { httpOnly: true, secure, sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 30, path: "/" };
  cookieStore.set(AUTH_COOKIE, token, opts);
  cookieStore.set(USER_INFO_COOKIE, JSON.stringify({ email: user.email, name: user.name || name }), opts);

  return NextResponse.json(
    { success: true, user: { id: user.id, email: user.email, name: user.name ?? name } },
    { headers: NO_STORE },
  );
}
