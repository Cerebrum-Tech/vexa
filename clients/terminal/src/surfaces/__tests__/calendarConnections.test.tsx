/** Settings → Calendar, the multi-calendar manager (#1150 plural API).
 *
 *  The behaviours worth pinning are the ones a refactor would quietly lose: the secret feed is
 *  never rendered or prefilled, the ten-connection cap is stated in the UI instead of arriving as
 *  a surprise 409, disconnect says what it destroys BEFORE it fires, and a PATCH that changes what
 *  gets joined is followed by the sync that reconciles already-imported meetings (while a rename,
 *  which changes nothing downstream, is not).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { CalendarConnectionsPanel, patchNeedsSync, syncLine, feedLine, disconnectWarning } from "../calendarConnections";
import type { CalendarConnection } from "../plannedApi";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const SECRET = "https://calendar.google.com/calendar/ical/x/private-SUPERSECRET/basic.ics";

function cal(over: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: "cal-1", name: "Work", ics_url_set: true, ics_url_masked: "calendar.google.com/….ics",
    auto_join: true, bot_name: "Work Notes", enabled: true, ...over,
  };
}

interface Call { url: string; method: string; body?: string }

/** Stubs the whole plural surface. `createStatus` lets a test drive the 409/422 branch. */
function stubApi(list: CalendarConnection[], opts: {
  syncStamp?: Record<string, unknown>;
  createStatus?: number;
  createDetail?: string;
} = {}) {
  const calls: Call[] = [];
  let current = [...list];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: u, method, body: init?.body as string });

    if (/\/api\/user\/calendars\/[^/]+\/sync$/.test(u)) {
      return new Response(JSON.stringify(opts.syncStamp ?? { last_sync: "2026-08-14T15:30:00Z", counts: { created: 2, updated: 1 } }), { status: 200 });
    }
    if (/\/api\/user\/calendars\/[^/]+$/.test(u)) {
      if (method === "DELETE") {
        const id = u.split("/").pop()!;
        current = current.filter((c) => c.id !== id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const id = u.split("/").pop()!;
        const patch = JSON.parse((init?.body as string) || "{}");
        current = current.map((c) => (c.id === id ? { ...c, ...patch, ics_url_set: true } : c));
        return new Response(JSON.stringify(current.find((c) => c.id === id)), { status: 200 });
      }
    }
    if (u.endsWith("/api/user/calendars")) {
      if (method === "POST") {
        if (opts.createStatus) return new Response(JSON.stringify({ detail: opts.createDetail }), { status: opts.createStatus });
        const made = cal({ id: "cal-new", name: JSON.parse((init?.body as string) || "{}").name });
        current = [...current, made];
        return new Response(JSON.stringify(made), { status: 201 });
      }
      return new Response(JSON.stringify({ calendars: current }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }));
  return calls;
}

describe("pure helpers", () => {
  it("patchNeedsSync — only fields that change what gets joined", () => {
    expect(patchNeedsSync({ name: "Renamed" })).toBe(false);
    expect(patchNeedsSync({ auto_join: false })).toBe(true);
    expect(patchNeedsSync({ bot_name: "Notes" })).toBe(true);
    expect(patchNeedsSync({ enabled: false })).toBe(true);
    expect(patchNeedsSync({ ics_url: SECRET })).toBe(true);
  });

  it("syncLine — an error REPLACES the timestamp, it is not a footnote on a success", () => {
    const bad = syncLine({ last_sync: "2026-08-14T15:30:00Z", last_error: "HTTP 401 fetching the feed" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("HTTP 401 fetching the feed");
    expect(bad.text).not.toContain("Son eşitleme:");
    expect(syncLine(undefined).text).toBe("Henüz eşitlenmedi");
    expect(syncLine({ last_sync: "2026-08-14T15:30:00Z", counts: { created: 2, updated: 1 } }).text).toContain("2 içe aktarıldı, 1 güncellendi");
  });

  it("feedLine — set/not-set, and the mask is the only recognition hint", () => {
    expect(feedLine(cal())).toBe("Akış tanımlı · calendar.google.com/….ics");
    expect(feedLine(cal({ ics_url_masked: null }))).toBe("Akış tanımlı");
    expect(feedLine(cal({ ics_url_set: false, ics_url_masked: null }))).toBe("Akış tanımlı değil");
  });

  it("disconnectWarning names what is destroyed and what survives", () => {
    const w = disconnectWarning("Work");
    expect(w).toContain("Work");
    expect(w).toMatch(/Toplantılar listesinden kaldırılır ve bu toplantılara katılınmaz/);
    expect(w).toMatch(/elle planladığınız toplantılar kalır/);
  });
});

describe("the list", () => {
  it("renders each calendar with its own state and the cap-relative count", async () => {
    stubApi([cal(), cal({ id: "cal-2", name: "Personal", auto_join: false, enabled: false, bot_name: "Vexa" })]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText("2 / 10 takvim bağlı")).toBeTruthy();
    expect(screen.getByText(/Work Notes/)).toBeTruthy();
    // per-calendar policy is per-row, not global
    const autoJoins = screen.getAllByLabelText(/Otomatik katılım/i, { selector: "input" });
    expect(autoJoins.map((i) => (i as HTMLInputElement).checked)).toEqual([true, false]);
  });

  it("empty state is honest", async () => {
    stubApi([]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Henüz bağlı takvim yok.")).toBeTruthy());
  });

  it("a failed list is LOUD, never a fake empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "admin-api is down" }), { status: 502 })));
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/arka uç servisine ulaşamıyor/i));
  });
});

describe("the feed address is write-only", () => {
  it("no stored URL is ever rendered, and Replace-feed starts EMPTY", async () => {
    // A server that (wrongly) leaks the real address must still not put it on screen.
    stubApi([{ ...cal(), ics_url_masked: "calendar.google.com/….ics", ...({ ics_url: SECRET } as object) } as CalendarConnection]);
    const { container } = render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    expect(container.textContent).not.toContain("SUPERSECRET");

    fireEvent.click(screen.getByText("Düzenle"));
    const replace = screen.getByLabelText("Work için akış adresini değiştir") as HTMLInputElement;
    expect(replace.value).toBe("");
    expect(replace.type).toBe("password");
    expect(screen.getByText(/bir daha gösterilmez/)).toBeTruthy();
  });
});

describe("the ten-connection cap", () => {
  it("Add is refused locally at the cap, with the reason", async () => {
    stubApi(Array.from({ length: 10 }, (_, i) => cal({ id: `cal-${i}`, name: `Cal ${i}` })));
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("10 / 10 takvim bağlı")).toBeTruthy());
    expect((screen.getByText("+ Takvim ekle") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/birinin bağlantısını kesin/)).toBeTruthy();
  });

  it("under the cap Add is live, and a backend 409 still surfaces verbatim", async () => {
    stubApi([cal()], { createStatus: 409, createDetail: "Ten active calendar connections already exist." });
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("+ Takvim ekle")).toBeTruthy());
    fireEvent.click(screen.getByText("+ Takvim ekle"));
    fireEvent.change(screen.getByLabelText("Takvim adı"), { target: { value: "Second" } });
    fireEvent.change(screen.getByLabelText("Gizli ICS adresi"), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Bağlan"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Ten active calendar connections already exist."));
  });
});

describe("add", () => {
  it("POSTs the connection then syncs THAT id, and reports what it found", async () => {
    const calls = stubApi([]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("+ Takvim ekle")).toBeTruthy());
    fireEvent.click(screen.getByText("+ Takvim ekle"));
    fireEvent.change(screen.getByLabelText("Takvim adı"), { target: { value: "Work" } });
    fireEvent.change(screen.getByLabelText("Gizli ICS adresi"), { target: { value: SECRET } });
    fireEvent.change(screen.getByLabelText("Yeni takvim için bot adı"), { target: { value: "Work Notes" } });
    fireEvent.click(screen.getByText("Bağlan"));

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/3 yaklaşan toplantı içe aktarıldı/));
    const post = calls.find((c) => c.url.endsWith("/api/user/calendars") && c.method === "POST")!;
    expect(JSON.parse(post.body!)).toEqual({ name: "Work", ics_url: SECRET, auto_join: true, bot_name: "Work Notes" });
    expect(calls.some((c) => c.url.endsWith("/api/user/calendars/cal-new/sync") && c.method === "POST")).toBe(true);
  });

  it("a 422 from the backend is shown verbatim, and the form stays open", async () => {
    stubApi([], { createStatus: 422, createDetail: "That is an embed page, not an ICS feed." });
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("+ Takvim ekle")).toBeTruthy());
    fireEvent.click(screen.getByText("+ Takvim ekle"));
    fireEvent.change(screen.getByLabelText("Takvim adı"), { target: { value: "Work" } });
    fireEvent.change(screen.getByLabelText("Gizli ICS adresi"), { target: { value: "https://calendar.google.com/embed?src=x" } });
    fireEvent.click(screen.getByText("Bağlan"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("That is an embed page, not an ICS feed."));
    expect(screen.getByLabelText("Gizli ICS adresi")).toBeTruthy();
  });
});

describe("edit", () => {
  it("toggling auto-join PATCHes one calendar and then syncs it", async () => {
    const calls = stubApi([cal(), cal({ id: "cal-2", name: "Personal" })]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());
    fireEvent.click(screen.getAllByLabelText(/Otomatik katılım/i, { selector: "input" })[1]);

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/user/calendars/cal-2") && c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(patch.body!)).toEqual({ auto_join: false });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/user/calendars/cal-2/sync") && c.method === "POST")).toBe(true));
    // the OTHER calendar is untouched
    expect(calls.some((c) => c.url.includes("cal-1") && c.method === "PATCH")).toBe(false);
  });

  it("enabled is a pause, not a delete — PATCH, never DELETE", async () => {
    const calls = stubApi([cal()]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Etkin/i, { selector: "input" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ enabled: false });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("a rename alone PATCHes and does NOT trigger a follow-up sync", async () => {
    const calls = stubApi([cal()]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    fireEvent.click(screen.getByText("Düzenle"));
    fireEvent.change(screen.getByLabelText("Work için ad"), { target: { value: "Customer calls" } });
    fireEvent.click(screen.getByText("Kaydet"));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ name: "Customer calls" });
    const syncsAfterPatch = calls.slice(calls.findIndex((c) => c.method === "PATCH")).filter((c) => c.method === "POST" && c.url.includes("/sync"));
    expect(syncsAfterPatch).toEqual([]);
  });

  it("replacing the feed sends the new ics_url and re-syncs", async () => {
    const calls = stubApi([cal()]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    fireEvent.click(screen.getByText("Düzenle"));
    fireEvent.change(screen.getByLabelText("Work için akış adresini değiştir"), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Kaydet"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ ics_url: SECRET });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/user/calendars/cal-1/sync") && c.method === "POST")).toBe(true));
  });
});

describe("sync now", () => {
  it("syncs ONE calendar and renders its fresh stamp", async () => {
    const calls = stubApi([cal()], { syncStamp: { last_sync: "2026-08-14T15:30:00Z", counts: { created: 5, updated: 0 } } });
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    fireEvent.click(screen.getByText("Şimdi eşitle"));
    await waitFor(() => expect(screen.getByText(/5 içe aktarıldı, 0 güncellendi/)).toBeTruthy());
    expect(calls.filter((c) => c.url.endsWith("/api/user/calendars/cal-1/sync") && c.method === "POST").length).toBe(1);
  });

  it("a 200 carrying last_error reads as a FAILURE", async () => {
    stubApi([cal()], { syncStamp: { last_sync: "2026-08-14T15:30:00Z", last_error: "HTTP 404 fetching the feed" } });
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    fireEvent.click(screen.getByText("Şimdi eşitle"));
    await waitFor(() => expect(screen.getByText(/Son eşitleme başarısız: HTTP 404 fetching the feed/)).toBeTruthy());
  });
});

describe("disconnect", () => {
  it("states the consequence and needs a second click", async () => {
    const calls = stubApi([cal()]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());

    fireEvent.click(screen.getByText("Bağlantıyı kes"));
    expect(screen.getByText(/Yalnızca bu takvimden içe aktarılan toplantılar Toplantılar listesinden kaldırılır/)).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);   // nothing fired on the FIRST click

    fireEvent.click(screen.getByText("Evet, bağlantıyı kes"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/user/calendars/cal-1") && c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.getByText("Henüz bağlı takvim yok.")).toBeTruthy());
  });

  it("'Kalsın' backs out without touching the server", async () => {
    const calls = stubApi([cal()]);
    render(<CalendarConnectionsPanel />);
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    fireEvent.click(screen.getByText("Bağlantıyı kes"));
    fireEvent.click(screen.getByText("Kalsın"));
    await waitFor(() => expect(screen.queryByText(/Yalnızca bu takvimden içe aktarılan toplantılar/)).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByText("Work")).toBeTruthy();
  });
});
