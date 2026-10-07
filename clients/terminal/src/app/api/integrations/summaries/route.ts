/** GET /api/integrations/summaries?email=…[&since=…&until=…&limit=…] — one account's meeting
 *  summaries for a system integrating with this deployment.
 *
 *  The caller is a service, not a signed-in browser: it presents the deployment's fixed
 *  `X-Summary-Api-Key`, and this route forwards that header and the query — never the session cookie's
 *  user key — to the gateway's `/integrations/summaries`, which hands it to agent-api. agent-api checks
 *  the key; nothing here decides access. Never cached: a cached answer would outlive a key rotation.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");
const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest): Promise<Response> {
  const headers: Record<string, string> = {};
  const key = req.headers.get("x-summary-api-key");
  if (key) headers["X-Summary-Api-Key"] = key;

  try {
    const upstream = await fetch(`${GATEWAY_URL}/integrations/summaries${req.nextUrl.search}`, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    });
    return new Response(await upstream.text(), { status: upstream.status, headers: NO_STORE });
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : "upstream unreachable";
    return new Response(JSON.stringify({ error: "upstream_unreachable", detail }), { status: 502, headers: NO_STORE });
  }
}
