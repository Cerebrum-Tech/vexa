/** Server-side proxy to admin-api's admin tier for the Kullanıcılar panel.
 *
 *  The X-Admin-API-Key is a deployment secret and never reaches the browser: every call is made
 *  here, from the server, after `requireAdmin()` has VERIFIED the caller against admin-api's
 *  internal oracle. A non-admin gets 404 (invisible), never 403 (discoverable) — the same shape
 *  the infra panel's routes use.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "../gate";

const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store" } as const;

function config(): { url: string; key: string } | null {
  const url = (process.env.VEXA_ADMIN_API_URL || "").replace(/\/$/, "");
  const key = process.env.VEXA_ADMIN_API_KEY || "";
  return url && key ? { url, key } : null;
}

/** Proxy one admin-tier call. Returns admin-api's status and body verbatim so the panel can
 *  render the real error rather than a flattened one. */
export async function adminProxy(path: string, init: RequestInit = {}): Promise<NextResponse> {
  const admin = await requireAdmin();
  if (!admin) return new NextResponse(null, { status: 404 });

  const cfg = config();
  if (!cfg) {
    return NextResponse.json(
      { error: "Yönetici API’si yapılandırılmamış (VEXA_ADMIN_API_URL / VEXA_ADMIN_API_KEY)." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Admin-API-Key": cfg.key, ...(init.headers || {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    return new NextResponse(body || null, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: `admin-api'ye ulaşılamadı: ${(err as Error).message}` },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
