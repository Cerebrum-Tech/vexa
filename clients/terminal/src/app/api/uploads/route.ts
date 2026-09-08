/** POST /api/uploads · GET /api/uploads?id=… — the media-upload edge.
 *
 *  Its own route file rather than the catch-all `/api/[...path]`, for one reason: that proxy reads
 *  the body with `await req.text()` and re-sends it as `application/json`. A multipart upload has a
 *  boundary in its Content-Type and bytes that are not text, so it must be relayed as a STREAM with
 *  its own content type intact — and a gigabyte recording must never be buffered in the terminal
 *  process on the way through.
 *
 *  Everything else is the same shape as every other proxy here: the per-user X-API-Key is injected
 *  server-side from the cookie token and the single gateway edge is the only upstream.
 */
import type { NextRequest } from "next/server";
import { resolveApiKey } from "../proxyAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function POST(req: NextRequest): Promise<Response> {
  const key = await resolveApiKey();
  if (!key) return json({ error: "Oturumunuz doğrulanamadı — yeniden giriş yapın." }, 401);
  const contentType = req.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data")) {
    return json({ error: "Kayıt dosyası bekleniyordu." }, 415);
  }
  try {
    const upstream = await fetch(`${GATEWAY_URL}/uploads`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": contentType },
      body: req.body,
      // Node's fetch refuses a stream body without this; it is what keeps the recording from
      // being buffered here on its way to the gateway.
      duplex: "half",
      cache: "no-store",
    } as RequestInit & { duplex: "half" });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  } catch {
    return json({ error: "Kayıt yüklenemedi — sunucuya ulaşılamadı." }, 502);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const key = await resolveApiKey();
  if (!key) return json({ error: "Oturumunuz doğrulanamadı — yeniden giriş yapın." }, 401);
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !/^\d+$/.test(id)) return json({ error: "Geçersiz yükleme kimliği." }, 400);
  try {
    const upstream = await fetch(`${GATEWAY_URL}/uploads/${id}`, {
      headers: { "X-API-Key": key },
      cache: "no-store",
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  } catch {
    return json({ error: "Yükleme durumu okunamadı." }, 502);
  }
}
