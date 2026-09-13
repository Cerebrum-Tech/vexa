/** Every meeting parameter stays local until explicit submission. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import type { MeetingMock } from "../meetingModel";
const openTab = vi.fn(), closeTab = vi.fn();
let meetings: MeetingMock[] = [];
vi.mock("../../platform", async (original) => ({ ...(await original<Record<string, unknown>>()), useService: () => ({ openTab, closeTab }) }));
vi.mock("../liveMeetings", () => ({ useLiveMeetings: () => meetings, refreshMeetings: vi.fn() }));
vi.mock("../plannedApi", () => ({ createPlannedMeeting: vi.fn(), updatePlannedMeeting: vi.fn(), deletePlannedMeeting: vi.fn() }));
vi.mock("../workspaceApi", () => ({ createSharedWorkspace: vi.fn(), listSharedMemberships: vi.fn(), listWorkspaceTree: vi.fn(), mintInvite: vi.fn(), readWorkspaceFile: vi.fn() }));
vi.mock("../briefNote", () => ({ findBriefNote: () => null, isExampleNote: () => false }));
// The picker has separate calendar tests; this exercises its controlled form boundary.
vi.mock("../../ui-kit/DateTimePicker", () => ({ DateTimePicker: ({ value, onChange, onClear, disabled }: {
  value?: string; onChange: (v: string) => void; onClear: () => void; disabled: boolean;
}) => <><input aria-label="Plan tarihi" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} /><button disabled={disabled} onClick={onClear}>Saati kaldır</button></> }));
import { registry } from "../../contributions";
import { prepDraftTabDescriptor, PREP_DRAFT_TAB_ID } from "../meetingPrep";
import * as planned from "../plannedApi";
import * as workspace from "../workspaceApi";
import { refreshMeetings } from "../liveMeetings";
const now = "2026-09-10T13:37:00.000Z", chosen = "2026-09-12T09:15:00.000Z", url = "https://meet.google.com/abc-defg-hij";
const row = { id: 77, platform: "google_meet", native_meeting_id: "abc-defg-hij", status: "scheduled", constructed_meeting_url: url, data: {} };
const fixture = (id = "42"): MeetingMock => ({ id, title: "Eski", title_custom: "Eski", when: "", status: "past", live_status: "scheduled", scheduled_at: chosen, auto_join: true, meeting_url: url, native_id: "abc-defg-hij", platform: "Google Meet", participants: [], mentioned: [], actions: [], transcript: [], insights: [] });
const renderPrep = (id = "") => { const C = registry.tabComponent("meetingPrep")!; return render(<C id={id ? `prep:${id}` : PREP_DRAFT_TAB_ID} params={{ meetingId: id, draft: !id }} active />); };
const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
function fill() {
  const title = screen.getByPlaceholderText("Bu toplantı ne hakkında?"); fireEvent.change(title, { target: { value: "Acme sync" } }); fireEvent.blur(title);
  const link = screen.getByPlaceholderText("https://meet.google.com/…"); fireEvent.change(link, { target: { value: url } }); fireEvent.blur(link);
}
beforeEach(() => {
  vi.resetAllMocks(); meetings = []; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  vi.mocked(planned.createPlannedMeeting).mockResolvedValue(row);
  vi.mocked(planned.updatePlannedMeeting).mockImplementation(async (id) => ({ ...row, id: Number(id) }));
  vi.mocked(workspace.listSharedMemberships).mockResolvedValue([{ workspace_id: "team", role: "owner" }] as never);
  vi.mocked(workspace.listWorkspaceTree).mockResolvedValue([]); vi.mocked(workspace.readWorkspaceFile).mockResolvedValue(null);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 77 }), { status: 201 })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("meetingPrep explicit submission", () => {
  it("opens a stable local draft at the current time and requires saving before preparation actions", () => {
    expect(prepDraftTabDescriptor()).toMatchObject({ id: PREP_DRAFT_TAB_ID, params: { meetingId: "", draft: true } }); renderPrep();
    expect(value("Plan tarihi")).toBe(now); expect(planned.createPlannedMeeting).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Hazırlık sohbetini başlat" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "+ Paylaşmak için çalışma alanı oluştur" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Önce.*Planla.*Katıl/)).toBeTruthy();
  });
  it("keeps every field local through blur/change and creates once with the complete explicit schedule", async () => {
    renderPrep(); fill(); fireEvent.keyDown(screen.getByPlaceholderText("Bu toplantı ne hakkında?"), { key: "Enter" });
    fireEvent.change(screen.getByLabelText("Plan tarihi"), { target: { value: chosen } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Otomatik katılım/ }));
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "team" } });
    expect(planned.createPlannedMeeting).not.toHaveBeenCalled(); expect(planned.updatePlannedMeeting).not.toHaveBeenCalled(); expect(refreshMeetings).not.toHaveBeenCalled(); expect(openTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Planla" }));
    await waitFor(() => expect(planned.createPlannedMeeting).toHaveBeenCalledTimes(1));
    expect(planned.createPlannedMeeting).toHaveBeenCalledWith({ title: "Acme sync", meeting_url: url, scheduled_at: chosen, workspace_id: "team", auto_join: false });
    expect(planned.updatePlannedMeeting).not.toHaveBeenCalled();
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "prep:77" }))); expect(closeTab).toHaveBeenCalledWith(PREP_DRAFT_TAB_ID);
  });
  it("patches an existing canonical row only on submit, including clearing date and workspace", async () => {
    meetings = [{ ...fixture(), workspace_id: "team" }]; renderPrep("42");
    fireEvent.click(screen.getByTitle("Daha fazla — bağlantıyı düzenle, çalışma alanı bağını kaldır, sil")); fill();
    fireEvent.click(screen.getByRole("button", { name: "Saati kaldır" })); fireEvent.click(screen.getByRole("button", { name: "Çalışma alanı bağını kaldır" }));
    expect(planned.updatePlannedMeeting).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Planla" }));
    await waitFor(() => expect(planned.updatePlannedMeeting).toHaveBeenCalledWith("42", { title: "Acme sync", meeting_url: url, scheduled_at: null, workspace_id: null, auto_join: true })); expect(planned.createPlannedMeeting).not.toHaveBeenCalled();
  });
  it("preserves same-row edits on feed refresh but resets all fields when changing canonical IDs", () => {
    meetings = [fixture(), { ...fixture("43"), title_custom: "Diğer", scheduled_at: now, auto_join: false, workspace_id: "team" }]; const view = renderPrep("42");
    fireEvent.change(screen.getByPlaceholderText("Bu toplantı ne hakkında?"), { target: { value: "Yerel" } }); fireEvent.change(screen.getByLabelText("Plan tarihi"), { target: { value: "2026-09-15T10:00:00.000Z" } });
    meetings = meetings.map((m) => ({ ...m })); const C = registry.tabComponent("meetingPrep")!; view.rerender(<C id="preview" params={{ meetingId: "42" }} active />);
    expect((screen.getByPlaceholderText("Bu toplantı ne hakkında?") as HTMLInputElement).value).toBe("Yerel"); expect(value("Plan tarihi")).toBe("2026-09-15T10:00:00.000Z");
    view.rerender(<C id="preview" params={{ meetingId: "43" }} active />); expect((screen.getByPlaceholderText("Bu toplantı ne hakkında?") as HTMLInputElement).value).toBe("Diğer"); expect(value("Plan tarihi")).toBe(now);
    expect((screen.getByRole("checkbox", { name: /Otomatik katılım/ }) as HTMLInputElement).checked).toBe(false); expect(planned.updatePlannedMeeting).not.toHaveBeenCalled();
  });
  it("retains the persisted ID and draft after failed Join and retries that row without duplication", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Bot bağlantısı kurulamadı" }), { status: 503 })); vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...row, shared: false }), { status: 200 })); renderPrep(); fill(); fireEvent.click(screen.getByRole("button", { name: "Katıl" }));
    await screen.findByRole("alert"); expect(planned.createPlannedMeeting).toHaveBeenCalledWith(expect.objectContaining({ auto_join: false, scheduled_at: now, title: "Acme sync", meeting_url: url }));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ meeting_id: 77, native_meeting_id: "abc-defg-hij", meeting_url: url }); expect(openTab).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Bu toplantı ne hakkında?") as HTMLInputElement).value).toBe("Acme sync"); fireEvent.click(screen.getByRole("button", { name: "Katıl" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3)); expect(planned.createPlannedMeeting).toHaveBeenCalledTimes(1); expect(planned.updatePlannedMeeting).toHaveBeenCalledWith("77", expect.objectContaining({ auto_join: false }));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[2][1]?.body)).meeting_id).toBe(77); await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "meeting:77" })));
  });
  it("reconciles a lost Join response to the already active canonical run without another write", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost"));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...row, status: "active", shared: false }), { status: 200 }));
    renderPrep(); fill(); fireEvent.click(screen.getByRole("button", { name: "Katıl" })); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Katıl" }));
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "meeting:77" })));
    expect(planned.createPlannedMeeting).toHaveBeenCalledTimes(1); expect(planned.updatePlannedMeeting).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("/api/meetings/77");
  });
  it("preserves a confirmed failed run and creates a new row only on explicit Join retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: "spawn failed" }), { status: 502 }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...row, status: "failed", shared: false }), { status: 200 }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ id: 78 }), { status: 201 }));
    vi.mocked(planned.createPlannedMeeting).mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, id: 78 });
    renderPrep(); fill(); fireEvent.click(screen.getByRole("button", { name: "Katıl" })); await screen.findByRole("alert");
    expect(planned.createPlannedMeeting).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Katıl" }));
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "meeting:78" })));
    expect(planned.createPlannedMeeting).toHaveBeenCalledTimes(2); expect(planned.updatePlannedMeeting).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[2][1]?.body)).meeting_id).toBe(78);
  });
  it.each([403, 404])("never recreates a retained row after an authorization recheck returns %s", async (status) => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost"));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: "unavailable" }), { status }));
    renderPrep(); fill(); fireEvent.click(screen.getByRole("button", { name: "Katıl" })); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Katıl" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); await screen.findByRole("alert");
    expect(planned.createPlannedMeeting).toHaveBeenCalledTimes(1); expect(planned.updatePlannedMeeting).not.toHaveBeenCalled(); expect(openTab).not.toHaveBeenCalled();
  });
  it("allows retry after a failed create while preserving inputs", async () => {
    vi.mocked(planned.createPlannedMeeting).mockRejectedValueOnce(new Error("unavailable")); renderPrep(); fill(); fireEvent.click(screen.getByRole("button", { name: "Planla" })); await screen.findByRole("alert");
    expect((screen.getByPlaceholderText("Bu toplantı ne hakkında?") as HTMLInputElement).value).toBe("Acme sync"); fireEvent.click(screen.getByRole("button", { name: "Planla" })); await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "prep:77" }))); expect(planned.createPlannedMeeting).toHaveBeenCalledTimes(2);
  });
  it("ignores repeated clicks while a save is pending", async () => {
    let resolve!: (value: typeof row) => void; vi.mocked(planned.createPlannedMeeting).mockImplementationOnce(() => new Promise((done) => { resolve = done; })); renderPrep(); fill(); const button = screen.getByRole("button", { name: "Planla" }); fireEvent.click(button); fireEvent.click(button); expect(planned.createPlannedMeeting).toHaveBeenCalledTimes(1); resolve(row); await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "prep:77" })));
  });
});
