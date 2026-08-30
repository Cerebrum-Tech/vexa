/** Meetings user onboarding (frames 4–5): the three-path empty state, the STANDING slim
 *  calendar card (state-driven — exists exactly while no calendar is connected), and the
 *  connect modal's answer-on-connect behavior. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("../../platform", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useService: () => ({ openTab: vi.fn() }),
}));

import { MeetingsOnboarding, connectOutcome } from "../meetingsOnboarding";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubCalendarApi(opts: { connected: boolean; syncCounts?: { created?: number; updated?: number }; syncError?: string }) {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const CAL = { id: "cal-1", name: "My calendar", ics_url_set: true, ics_url_masked: "calendar.google.com/…d3f1", auto_join: true, bot_name: "Vexa", enabled: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method, body: init?.body as string });
      if (/\/api\/user\/calendars\/[^/]+\/sync$/.test(u)) {
        if (opts.syncError) return new Response(JSON.stringify({ last_error: opts.syncError }), { status: 200 });
        return new Response(JSON.stringify({ last_sync: new Date().toISOString(), counts: opts.syncCounts ?? {} }), { status: 200 });
      }
      if (u.includes("/api/user/calendars")) {
        if (init?.method === "POST") return new Response(JSON.stringify(CAL), { status: 201 });
        return new Response(JSON.stringify({ calendars: opts.connected ? [CAL] : [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
  return calls;
}

describe("connectOutcome", () => {
  it("sync error → loud", () => {
    const o = connectOutcome({ last_error: "HTTP 401 — that looks like the public address" });
    expect(o.ok).toBe(false);
    expect(o.text).toContain("HTTP 401");
  });
  it("counts → 'N yaklaşan toplantı içe aktarıldı'", () => {
    expect(connectOutcome({ counts: { created: 11, updated: 1 } }).text).toContain("12 yaklaşan toplantı içe aktarıldı");
    expect(connectOutcome({ counts: { created: 1 } }).text).toContain("1 yaklaşan toplantı içe aktarıldı");
  });
  it("zero found → honest, not silent", () => {
    expect(connectOutcome({ counts: {} }).text).toContain("katılınabilir bağlantısı olan yaklaşan bir toplantı henüz bulunamadı");
  });
});

describe("slim — the standing affordances on a populated Meetings page", () => {
  it("calendar card renders while NO calendar is connected", async () => {
    stubCalendarApi({ connected: false });
    render(<MeetingsOnboarding variant="slim" />);
    await waitFor(() => expect(screen.getByText(/Bağlı takvim yok/)).toBeTruthy());
  });

  it("calendar card disappears once connected — plan + drop-bot STAY", async () => {
    const calls = stubCalendarApi({ connected: true });
    const { container } = render(<MeetingsOnboarding variant="slim" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/user/calendars"))).toBe(true));
    expect(container.textContent).not.toContain("Bağlı takvim yok");
    expect(screen.getByText("+ Toplantı planla")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Toplantı bağlantısını yapıştırın/)).toBeTruthy();
  });

  it("plan + drop-bot are there in the disconnected state too", async () => {
    stubCalendarApi({ connected: false });
    render(<MeetingsOnboarding variant="slim" />);
    await waitFor(() => expect(screen.getByText("+ Toplantı planla")).toBeTruthy());
    expect(screen.getByPlaceholderText(/Toplantı bağlantısını yapıştırın/)).toBeTruthy();
  });
});

describe("full — the three-path empty state", () => {
  it("shows all three paths, calendar first, when nothing is connected", async () => {
    stubCalendarApi({ connected: false });
    render(<MeetingsOnboarding variant="full" />);
    await waitFor(() => expect(screen.getByText("Takviminizi bağlayın")).toBeTruthy());
    expect(screen.getByText("Toplantı planla")).toBeTruthy();
    expect(screen.getByText("Hemen bot gönder")).toBeTruthy();
  });

  it("calendar card retires once connected; plan/drop remain", async () => {
    const calls = stubCalendarApi({ connected: true });
    render(<MeetingsOnboarding variant="full" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/user/calendars"))).toBe(true));
    await waitFor(() => expect(screen.getByText(/Takvim bağlandı/)).toBeTruthy());
    expect(screen.queryByText("Takviminizi bağlayın")).toBeNull();
    expect(screen.getByText("Toplantı planla")).toBeTruthy();
  });
});

describe("connect modal — teaches the secret address and answers on connect", () => {
  it("walkthrough + paste → POST /user/calendars + sync-now → reports what it found", async () => {
    const calls = stubCalendarApi({ connected: false, syncCounts: { created: 3 } });
    render(<MeetingsOnboarding variant="slim" />);
    await waitFor(() => screen.getByText("Takvimi bağla →"));
    fireEvent.click(screen.getByText("Takvimi bağla →"));

    // the explainer is THERE — secret-address step + the Workspace-admin trap
    expect(screen.getByText(/iCal biçimindeki gizli adres/)).toBeTruthy();
    expect(screen.getByText(/Google Workspace yöneticiniz bu ayarı kilitlemiştir/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/basic\.ics/), {
      target: { value: "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics" },
    });
    fireEvent.click(screen.getByText("Bağlan"));

    await waitFor(() => expect(screen.getByText(/3 yaklaşan toplantı içe aktarıldı/)).toBeTruthy());
    // first connect CREATES connection #1 on the plural API, with a name…
    const post = calls.find((c) => c.url.endsWith("/api/user/calendars") && c.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(post!.body as string)).toMatchObject({ name: "Takvimim", auto_join: true });
    // …then syncs THAT connection by id (the backend does not sync on create)
    expect(calls.some((c) => /\/api\/user\/calendars\/cal-1\/sync$/.test(c.url) && c.method === "POST")).toBe(true);
  });

  it("first-sync failure is loud, with the server's reason", async () => {
    stubCalendarApi({ connected: false, syncError: "HTTP 401 fetching the feed — that looks like the public address, not the secret one" });
    render(<MeetingsOnboarding variant="slim" />);
    await waitFor(() => screen.getByText("Takvimi bağla →"));
    fireEvent.click(screen.getByText("Takvimi bağla →"));
    fireEvent.change(screen.getByPlaceholderText(/basic\.ics/), {
      target: { value: "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics" },
    });
    fireEvent.click(screen.getByText("Bağlan"));
    await waitFor(() => expect(screen.getByText(/ilk eşitleme başarısız oldu/)).toBeTruthy());
    expect(screen.getByText(/ilk eşitleme başarısız oldu/).textContent).toContain("public address, not the secret one");
  });
});
