import { afterEach, describe, expect, it, vi } from "vitest";

/** Mutable cookie jar the mocked next/headers reads from. */
let jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import { resolveApiKey } from "../proxyAuth";
import { GET as catchAllGet, PUT as catchAllPut, PATCH as catchAllPatch } from "../[...path]/route";

function makeReq(search = ""): import("next/server").NextRequest {
  return { method: "GET", nextUrl: { search } } as unknown as import("next/server").NextRequest;
}

function makeReqM(method: string, body = "", search = ""): import("next/server").NextRequest {
  return { method, nextUrl: { search }, text: async () => body } as unknown as import("next/server").NextRequest;
}

afterEach(() => {
  jar = new Map();
  delete process.env.VEXA_API_KEY;
  delete process.env.VEXA_BOT_API_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveApiKey — cookie token with env fallback", () => {
  it("prefers the vexa-token cookie", async () => {
    jar.set("vexa-token", "user-token-123");
    process.env.VEXA_API_KEY = "env-key";
    process.env.VEXA_BOT_API_KEY = "bot-key";
    expect(await resolveApiKey()).toBe("user-token-123");
  });

  it("falls back to VEXA_API_KEY, then VEXA_BOT_API_KEY", async () => {
    process.env.VEXA_API_KEY = "env-key";
    process.env.VEXA_BOT_API_KEY = "bot-key";
    expect(await resolveApiKey()).toBe("env-key");

    delete process.env.VEXA_API_KEY;
    expect(await resolveApiKey()).toBe("bot-key");

    delete process.env.VEXA_BOT_API_KEY;
    expect(await resolveApiKey()).toBe("");
  });
});

describe("catch-all proxy — meetings domain forwards the cookie token as X-API-Key", () => {
  it("injects the cookie token on a /bots call", async () => {
    jar.set("vexa-token", "cookie-tok");
    const seen: { url?: string; key?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.key = (init?.headers as Record<string, string>)?.["X-API-Key"];
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await catchAllGet(makeReq(), { params: Promise.resolve({ path: ["bots"] }) });

    expect(seen.url).toContain("/bots");
    expect(seen.key).toBe("cookie-tok");
  });

  it("falls back to VEXA_BOT_API_KEY when no cookie is present", async () => {
    process.env.VEXA_BOT_API_KEY = "legacy-bot-key";
    const seen: { key?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.key = (init?.headers as Record<string, string>)?.["X-API-Key"];
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await catchAllGet(makeReq(), { params: Promise.resolve({ path: ["meetings"] }) });

    expect(seen.key).toBe("legacy-bot-key");
  });
});

describe("catch-all proxy — PATCH and PUT verbs forward (regression: handler exported only GET/POST/DELETE → 405)", () => {
  it("forwards PATCH to the agent domain, body intact (routine enable/disable)", async () => {
    jar.set("vexa-token", "tok");
    const seen: { url?: string; method?: string; body?: unknown } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.method = init?.method;
        seen.body = init?.body;
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await catchAllPatch(makeReqM("PATCH", JSON.stringify({ enabled: false })), {
      params: Promise.resolve({ path: ["routines", "daily", "enabled"] }),
    });

    expect(seen.method).toBe("PATCH");
    expect(seen.url).toContain("/agent/routines/daily/enabled");
    expect(seen.body).toBe(JSON.stringify({ enabled: false }));
  });

  it("forwards PUT to the meetings domain (schedule/cancel intent)", async () => {
    jar.set("vexa-token", "tok");
    const seen: { url?: string; method?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.method = init?.method;
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await catchAllPut(makeReqM("PUT", JSON.stringify({ intent: "scheduled" })), {
      params: Promise.resolve({ path: ["meetings", "google_meet", "abc", "intent"] }),
    });

    expect(seen.method).toBe("PUT");
    expect(seen.url).toContain("/meetings/google_meet/abc/intent");
  });
});


describe("catch-all proxy — explicit summary edits", () => {
  it.each([200, 409])("forwards canonical scope and revision to agent-api and preserves status %s", async (status) => {
    jar.set("vexa-token", "summary-owner-token");
    const body = JSON.stringify({ workspace: "owner-workspace", path: "/meetings/run/report.md", expected_revision: "report-sha256", summary: "Düzenlenen özet." });
    const responseBody = status === 200
      ? { meeting_id: 42, workspace: "owner-workspace", path: "/meetings/run/report.md", revision: "next-sha256", content: "committed report" }
      : { detail: "Report revision changed" };
    const upstream = vi.fn(async () => new Response(JSON.stringify(responseBody), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", upstream);

    const response = await catchAllPatch(makeReqM("PATCH", body), {
      params: Promise.resolve({ path: ["meeting", "42", "summary"] }),
    });

    expect(upstream).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\/agent\/meeting\/42\/summary$/), {
      method: "PATCH", cache: "no-store", body,
      headers: { "X-API-Key": "summary-owner-token", "Content-Type": "application/json" },
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(responseBody);
  });
});
