import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServicesProvider, createContainer, reg } from "../../platform";
import { LayoutServiceId, createLayoutService } from "../../workbench/layout";
import type { MeetingMock } from "../meetingModel";
const state = vi.hoisted(() => ({ meetings: [] as MeetingMock[] }));
vi.mock("../liveMeetings", () => ({ useLiveMeetings: () => state.meetings, useLiveMeetingsLoaded: () => true,
  useLiveMeetingsError: () => null, useLiveMeetingsConnection: () => true, refreshMeetings: vi.fn() }));
vi.mock("../meetingsOnboarding", async (original) => ({ ...(await original<object>()), MeetingsOnboarding: () => null }));
vi.mock("../jitsiHosts", () => ({ getJitsiHosts: async () => [] }));
import { TodayView } from "../today";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const row = (id: string, shared = false): MeetingMock => ({ id, title: `Toplantı ${id}`, when: "", status: "past", live_status: "completed", native_id: "same-link", platform: "Google Meet", shared, start_time: "2026-09-10T10:00:00", participants: [], mentioned: [], actions: [], transcript: [], insights: [] });
function view() {
  const layout = createLayoutService("meetings");
  layout.usePages();
  render(<ServicesProvider container={createContainer([reg(LayoutServiceId, () => layout)])}><TodayView /></ServicesProvider>);
  return layout;
}
describe("meeting library", () => {
  it("offers recording upload from both empty and populated libraries", () => {
    for (const meetings of [[], [row("saved")]]) {
      state.meetings = meetings;
      view();
      expect(screen.getByRole("button", { name: /Kayıt yükle/ })).toBeTruthy();
      cleanup();
    }
  });
  it("joins directly from the populated library and opens the returned canonical meeting", async () => {
    state.meetings = [row("saved")];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: 54 }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const layout = view();
    fireEvent.change(screen.getByRole("textbox", { name: "Toplantı bağlantısı" }), { target: { value: "https://teams.microsoft.com/meet/123456789?p=sample" } });
    fireEvent.submit(screen.getByRole("form", { name: "Canlı toplantıya katıl" }));
    await waitFor(() => expect(layout.store.getState().page?.id).toBe("meeting:54"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/bots");
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({
      platform: "teams", native_meeting_id: "123456789", meeting_url: "https://teams.microsoft.com/meet/123456789?p=sample",
    });
  });
  it("keeps ongoing meetings one click away while browsing history", () => {
    state.meetings = [row("saved"), { ...row("live"), status: "live", live_status: "active" }];
    const layout = view();
    expect(screen.getByRole("tab", { name: /Geçmiş/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Canlı toplantıyı aç: Toplantı live" }));
    expect(layout.store.getState().page?.id).toBe("meeting:live");
  });
  it("renders more than eight recurring runs and opens the exact run without recording claims", () => {
    state.meetings = Array.from({ length: 12 }, (_, i) => row(String(i)));
    const layout = view();
    expect(screen.getAllByRole("button", { name: /Toplantı 11/ })[0]).toBeTruthy();
    expect(screen.queryByText("kayıt alınmadı")).toBeNull();
    expect(screen.queryByText("özet hazır")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /Toplantı 11/ })[0]);
    expect(layout.store.getState().page?.id).toBe("meeting:11");
  });
  it("search and ownership filters change visible authorized rows", () => {
    state.meetings = [row("sahip"), row("ortak", true)];
    view();
    fireEvent.change(screen.getByLabelText("Toplantı ara"), { target: { value: "ortak" } });
    expect(screen.queryByRole("button", { name: /Toplantı sahip/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Toplantı ortak/ })[0]).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Sahiplik"), { target: { value: "mine" } });
    expect(screen.queryByRole("button", { name: /Toplantı ortak/ })).toBeNull();
  });
  it("shows distant upcoming and live runs, and hides mutation controls on shared meetings", () => {
    state.meetings = [{ ...row("canlı", true), status: "live", live_status: "active" }, { ...row("gelecek"), live_status: "scheduled", scheduled_at: "2027-03-10T10:00:00" }];
    view();
    fireEvent.click(screen.getByRole("tab", { name: /Canlı/ }));
    expect(screen.getAllByRole("button", { name: /Toplantı canlı/ })[0]).toBeTruthy();
    expect(screen.queryByTitle("İşlemler")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Yaklaşan/ }));
    expect(screen.getAllByRole("button", { name: /Toplantı gelecek/ })[0]).toBeTruthy();
    expect(screen.getByTitle("İşlemler")).toBeTruthy();
  });
});
