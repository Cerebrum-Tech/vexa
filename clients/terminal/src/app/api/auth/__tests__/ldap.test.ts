import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Cookie jar the mocked next/headers writes into, so the test can assert what login set. */
let setCookies: Array<{ name: string; value: string; opts?: unknown }> = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, opts?: unknown) => setCookies.push({ name, value, opts }),
    delete: () => {},
  }),
}));

/** Scriptable ldapts stand-in — each test sets `binds`/`entries` before importing the route. */
const ldap = {
  /** DN → outcome for bind(): "ok" resolves, "bad" throws result-code-49. */
  binds: new Map<string, "ok" | "bad">(),
  /** Entries returned by the service-account search. */
  entries: [] as Array<Record<string, unknown>>,
};

class FakeInvalidCredentials extends Error {
  code = 49;
  constructor() {
    super("80090308: LdapErr … data 52e");
    this.name = "InvalidCredentialsError";
  }
}

vi.mock("ldapts", () => ({
  Client: class {
    async bind(dn: string, _password: string) {
      if (ldap.binds.get(dn) === "bad") throw new FakeInvalidCredentials();
    }
    async search() {
      return { searchEntries: ldap.entries };
    }
    async unbind() {}
  },
}));

const SERVICE_DN = "CN=svc,DC=corp,DC=example,DC=com";
const USER_DN = "CN=Ada Lovelace,OU=Users,DC=corp,DC=example,DC=com";

function makeReq(body: unknown): import("next/server").NextRequest {
  return { json: async () => body } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  setCookies = [];
  ldap.binds = new Map([[SERVICE_DN, "ok"]]);
  ldap.entries = [
    {
      dn: USER_DN,
      distinguishedName: USER_DN,
      sAMAccountName: "alovelace",
      mail: "ada.lovelace@corp.example.com",
      givenName: "Ada",
      sn: "Lovelace",
      userAccountControl: "512", // normal, enabled account
    },
  ];
  process.env.VEXA_ADMIN_API_URL = "http://admin.test";
  process.env.VEXA_ADMIN_API_KEY = "admin-secret";
  process.env.LDAP_URLS = "ldaps://dc.corp:636";
  process.env.LDAP_BIND_DN = SERVICE_DN;
  process.env.LDAP_BIND_PASSWORD = "svc-pass";
  process.env.LDAP_BASE_DN = "DC=corp,DC=example,DC=com";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/api/auth/ldap — domain sign-in against a mocked directory + admin-api", () => {
  it("binds, searches, re-binds as the user, mints a token and sets both cookies", async () => {
    ldap.binds.set(USER_DN, "ok"); // user password correct
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        if (url.includes("/admin/users/email/")) {
          return new Response(JSON.stringify({ id: 7, email: "ada.lovelace@corp.example.com", name: "Ada Lovelace" }), { status: 200 });
        }
        if (url.includes("/tokens")) {
          return new Response(JSON.stringify({ token: "minted-tok" }), { status: 200 });
        }
        return new Response("nope", { status: 500 });
      }),
    );

    const { POST } = await import("../ldap/route");
    const res = await POST(makeReq({ username: "alovelace", password: "correct-horse" }));
    expect(res.status).toBe(200);
    const names = setCookies.map((c) => c.name);
    expect(names).toContain("vexa-token");
    expect(names).toContain("vexa-user-info");
    expect(setCookies.find((c) => c.name === "vexa-token")?.value).toBe("minted-tok");
  });

  it("rejects a wrong password with 401 and sets no cookie", async () => {
    ldap.binds.set(USER_DN, "bad"); // user bind fails → code 49
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const { POST } = await import("../ldap/route");
    const res = await POST(makeReq({ username: "alovelace", password: "wrong" }));
    expect(res.status).toBe(401);
    expect(setCookies).toHaveLength(0);
  });

  it("GET reports enabled when LDAP_URLS is set", async () => {
    const { GET } = await import("../ldap/route");
    const res = await GET();
    expect(await res.json()).toEqual({ enabled: true });
  });
});
