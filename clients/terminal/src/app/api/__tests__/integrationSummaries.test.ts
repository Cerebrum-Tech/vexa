import { afterEach, describe, expect, it, vi } from "vitest";

/** The summaries integration route forwards ONLY the caller's X-Summary-Api-Key and query to the
 *  gateway — never a session cookie's user key — and returns the upstream answer verbatim. */

const cookieRead = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: cookieRead }) }));

import { GET } from "../integrations/summaries/route";

function makeReq(search: string, headers: Record<string, string>): import("next/server").NextRequest {
  return {
    method: "GET",
    nextUrl: { search },
    headers: new Headers(headers),
  } as unknown as import("next/server").NextRequest;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /api/integrations/summaries", () => {
  it("forwards the key header and query to the gateway's /integrations/summaries", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ count: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await GET(makeReq("?email=ayse%40innova.com.tr&limit=5", { "X-Summary-Api-Key": "k", Cookie: "vexa-token=tok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1 });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/integrations\/summaries\?email=ayse%40innova\.com\.tr&limit=5$/);
    expect(init.headers).toEqual({ "X-Summary-Api-Key": "k" });
    expect(cookieRead).not.toHaveBeenCalled();
  });

  it("sends no key when the caller sent none, and carries the 401 back", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ detail: "invalid" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await GET(makeReq("?email=a%40b.c", {}));
    expect(res.status).toBe(401);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({});
  });

  it("answers 502 when the gateway is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const res = await GET(makeReq("?email=a%40b.c", { "X-Summary-Api-Key": "k" }));
    expect(res.status).toBe(502);
  });
});
