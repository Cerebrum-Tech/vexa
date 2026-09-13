import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomaticMeetingRecap, READY_RECHECK_MS } from "../AutomaticMeetingRecap";
import * as workspaceApi from "../../surfaces/workspaceApi";
vi.mock("../../surfaces/workspaceApi", () => ({ readActiveSet: vi.fn(), readWorkspaceFile: vi.fn() }));
vi.mock("../../ui-kit/MdxDoc", () => ({ MdxDoc: ({ children }: { children: string }) => <div>{children}</div> }));
const path = "kg/entities/meeting/abc.run-42.md";
const tail = "\n\n## Alınan Kararlar\n\nCuma günü yayın.\n\n## Aksiyon Maddeleri\n\n- Ayşe: sürümü hazırla.";
function artifact(summary = "Mevcut özet.", id = "42", workspace = "team") {
  const body = `## Özet\n\n${summary}${tail}`;
  const revision = createHash("sha256").update(body).digest("hex");
  return { body, revision, content: `---\nmeeting_row_id: '${id}'\nreport_workspace: ${workspace}\nreport_status: completed\nreport_language: tr\nreport_revision: ${revision}\n---\n\n${body}` };
}
const initial = artifact();
function response(summary: string, id = "42", workspace = "team") {
  const next = artifact(summary, id, workspace);
  return new Response(JSON.stringify({ meeting_id: Number(id), workspace, path, revision: next.revision, content: next.content }), { status: 200 });
}
const props = { status: "completed", meetingId: "42", workspace: "team", reportPath: path };
async function openEditor() {
  fireEvent.click(await screen.findByRole("button", { name: "Özeti düzenle" }));
  return screen.getByRole("textbox", { name: "Toplantı özeti" }) as HTMLTextAreaElement;
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("crypto", {});
  vi.mocked(workspaceApi.readActiveSet).mockResolvedValue({ subject: "alice", active: [{ slug: "team", path: "/workspaces/team", role: "shared", write: true, primary: false, repo: null, ref: null }] });
  vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue(initial.content);
  vi.stubGlobal("fetch", vi.fn(async () => response("Yeni özet.")));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("explicit recap summary editing", () => {
  it.each([undefined, false])("shows a read-only report when edit permission is %s", async (canEdit) => {
    render(<AutomaticMeetingRecap {...props} canEdit={canEdit} />);
    await screen.findByText(/Mevcut özet/); expect(screen.queryByRole("button", { name: "Özeti düzenle" })).toBeNull();
  });
  it("edits only the summary locally and Cancel leaves every report section unchanged", async () => {
    render(<AutomaticMeetingRecap {...props} canEdit />); const input = await openEditor();
    expect(input.value).toBe("Mevcut özet."); expect(input.value).not.toContain("Alınan Kararlar");
    fireEvent.change(input, { target: { value: "Yerel taslak." } }); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Vazgeç" })); expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/Mevcut özet/)).toBeTruthy(); expect(screen.getByText(/Cuma günü yayın/)).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
  });
  it("saves only explicit summary text with canonical scope and the source revision, then shows verified committed content", async () => {
    render(<AutomaticMeetingRecap {...props} canEdit />); const input = await openEditor(); fireEvent.change(input, { target: { value: "Yeni özet." } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/meeting/42/summary");
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ workspace: "team", path, expected_revision: initial.revision, summary: "Yeni özet." });
    expect(screen.getByText(/Yeni özet/)).toBeTruthy(); expect(screen.getByText(/Cuma günü yayın/)).toBeTruthy(); expect(screen.getByText(/Ayşe: sürümü hazırla/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("kaydedildi");
  });
  it.each([409, 503])("keeps the complete draft and exposes a retryable error after save status %s", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Report update unavailable" }), { status }));
    render(<AutomaticMeetingRecap {...props} canEdit />); const input = await openEditor(); fireEvent.change(input, { target: { value: "Kaybolmayan taslak." } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" })); await screen.findByRole("alert");
    expect(input.value).toBe("Kaybolmayan taslak."); expect((screen.getByRole("button", { name: "Kaydet" }) as HTMLButtonElement).disabled).toBe(false); expect(screen.queryByText(/Özet kaydedildi/)).toBeNull();
  });
  it("preserves a draft and its original revision when the report refreshes underneath it", async () => {
    vi.useFakeTimers();
    await act(async () => { render(<AutomaticMeetingRecap {...props} canEdit />); });
    fireEvent.click(screen.getByRole("button", { name: "Özeti düzenle" })); const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Benim taslağım." } });
    vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue(artifact("Başka bir güncelleme.").content);
    await act(async () => { await vi.advanceTimersByTimeAsync(READY_RECHECK_MS); }); expect(input.value).toBe("Benim taslağım.");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: "revision conflict" }), { status: 409 }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Kaydet" })));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).expected_revision).toBe(initial.revision);
    expect(input.value).toBe("Benim taslağım.");
    fireEvent.click(screen.getByRole("button", { name: "Vazgeç" })); expect(screen.getByText(/Başka bir güncelleme/)).toBeTruthy();
  });
  it("waits for the committed response and rejects duplicate Save clicks", async () => {
    let done!: (result: Response) => void; vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { done = resolve; }));
    render(<AutomaticMeetingRecap {...props} canEdit />); const input = await openEditor(); fireEvent.change(input, { target: { value: "Yeni özet." } });
    const save = screen.getByRole("button", { name: "Kaydet" }); fireEvent.click(save); fireEvent.click(save);
    expect(fetch).toHaveBeenCalledTimes(1); expect(screen.getByRole("textbox")).toBeTruthy(); expect(screen.queryByText(/Özet kaydedildi/)).toBeNull();
    await act(async () => done(response("Yeni özet."))); expect(screen.queryByRole("textbox")).toBeNull();
  });
  it.each(["## Alınan Kararlar\nDeğiştir", "# Başlık", "   "])("rejects invalid summary-only input locally: %s", async (text) => {
    render(<AutomaticMeetingRecap {...props} canEdit />); fireEvent.change(await openEditor(), { target: { value: text } }); fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.getByRole("textbox")).toBeTruthy();
  });
  it.each([["43", "team"], ["42", "other"]])("does not accept a successful response for meeting %s / workspace %s", async (id, workspace) => {
    vi.mocked(fetch).mockResolvedValueOnce(response("Yeni özet.", id, workspace)); render(<AutomaticMeetingRecap {...props} canEdit />);
    const input = await openEditor(); fireEvent.change(input, { target: { value: "Yeni özet." } }); fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await screen.findByRole("alert"); expect(input.value).toBe("Yeni özet."); expect(screen.queryByText(/Özet kaydedildi/)).toBeNull();
  });
  it("hides editing controls immediately when ownership is lost", async () => {
    const view = render(<AutomaticMeetingRecap {...props} canEdit />); fireEvent.change(await openEditor(), { target: { value: "Yerel taslak." } });
    view.rerender(<AutomaticMeetingRecap {...props} canEdit={false} />);
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Özeti düzenle" })).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it("ignores an old save response after navigating to another canonical meeting", async () => {
    let done!: (result: Response) => void; vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { done = resolve; }));
    const view = render(<AutomaticMeetingRecap {...props} canEdit />); fireEvent.change(await openEditor(), { target: { value: "Eski toplantı taslağı." } }); fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue(artifact("Diğer toplantının özeti.", "43").content);
    view.rerender(<AutomaticMeetingRecap {...props} meetingId="43" reportPath="kg/entities/meeting/abc.run-43.md" canEdit />);
    await screen.findByText(/Diğer toplantının özeti/);
    await act(async () => done(response("Eski toplantı taslağı.")));
    expect(screen.getByText(/Diğer toplantının özeti/)).toBeTruthy(); expect(screen.queryByText(/Eski toplantı taslağı/)).toBeNull(); expect(screen.queryByText(/Özet kaydedildi/)).toBeNull();
  });
  it("hides a private editing draft when report access can no longer be confirmed", async () => {
    vi.useFakeTimers(); await act(async () => { render(<AutomaticMeetingRecap {...props} canEdit />); }); fireEvent.click(screen.getByRole("button", { name: "Özeti düzenle" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Özel taslak." } }); vi.mocked(workspaceApi.readActiveSet).mockResolvedValue({ subject: "alice", active: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(READY_RECHECK_MS); }); expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText(/Özel taslak/)).toBeNull(); expect(screen.getByRole("alert")).toBeTruthy();
  });
});
