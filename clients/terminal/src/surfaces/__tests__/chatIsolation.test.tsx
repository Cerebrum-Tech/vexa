import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../chat";
import { meetingConversationSession } from "../sessionsApi";
import { ServicesProvider, createContainer, createCommandService, CommandServiceId, reg } from "../../platform";
import { createLayoutService, LayoutServiceId } from "../../workbench/layout";
import type { StreamingDictation } from "../../ui-kit/micDictation";

vi.mock("../liveMeetings", () => ({ useLiveMeetings: () => [] }));
const dictation = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../ui-kit/micDictation", () => ({ startStreamingDictation: dictation.start }));

let sequence = 0;
let subject: string;
let streams: Map<string, ReadableStreamDefaultController<Uint8Array>>;
let signals: AbortSignal[];
let requests: { session: string; prompt: string; active?: { meeting_id?: string } }[];

beforeEach(() => {
  subject = `composer-user-${++sequence}`;
  streams = new Map();
  requests = [];
  signals = [];
  localStorage.clear();
  dictation.start.mockReset();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chat") {
      const req = JSON.parse(String(init?.body));
      requests.push(req);
      signals.push(init!.signal!);
      return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start: (controller) => streams.set(req.session, controller) }) };
    }
    return { ok: true, status: 200, json: async () => ({ sessions: [], turns: [] }) };
  }));
});
afterEach(() => { cleanup(); for (const stream of streams.values()) { try { stream.close(); } catch {} } vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
  const layout = createLayoutService("meetings");
  const container = createContainer([reg(LayoutServiceId, () => layout), reg(CommandServiceId, createCommandService)]);
  const view = (row: string, user = subject) => <ServicesProvider container={container}>
    <Chat params={{ subject: user, session: meetingConversationSession(user, row), meetingId: row }} />
  </ServicesProvider>;
  const result = render(view("42"));
  return { ...result, switchTo: (row: string, user = subject) => result.rerender(view(row, user)) };
}
const input = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("meeting composer isolation", () => {
  it("keeps each draft and attachment on A → B → A, with a separate user cache", async () => {
    const f = fixture();
    fireEvent.change(input(), { target: { value: "A draft" } });
    fireEvent.change(f.container.querySelector('input[type="file"]')!, { target: { files: [new File(["A"], "A.txt", { type: "text/plain" })] } });
    f.switchTo("43");
    expect(input().value).toBe("");
    expect(screen.queryByText("A.txt")).toBeNull();
    fireEvent.change(input(), { target: { value: "B draft" } });
    f.switchTo("42");
    expect(input().value).toBe("A draft");
    expect(screen.getByText("A.txt")).toBeTruthy();
    f.switchTo("42", "another-user");
    expect(input().value).toBe("");
    expect(screen.queryByText("A.txt")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Sohbet yükleniyor…")).toBeNull());
  });

  it("keeps a pending reply in the original conversation while B can send independently", async () => {
    const f = fixture();
    fireEvent.change(input(), { target: { value: "Question A" } });
    fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    f.switchTo("43");
    expect(screen.queryByText("Question A")).toBeNull();
    fireEvent.change(input(), { target: { value: "Question B" } });
    fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => {
      const stream = streams.get(requests[0].session)!;
      stream.enqueue(new TextEncoder().encode('data: {"type":"message-delta","text":"Reply A"}\n\ndata: {"type":"turn-complete"}\n\n'));
      stream.close();
    });
    expect(screen.queryByText("Reply A")).toBeNull();
    f.switchTo("42");
    expect(screen.getByText("Reply A")).toBeTruthy();
    expect(requests[0].session).not.toBe(requests[1].session);
  });

  it("cancels dictation on a meeting switch and discards late microphone results", async () => {
    let update: (confirmed: string, pending: string) => void = () => {};
    const cancel = vi.fn();
    dictation.start.mockImplementation(async (opts) => { update = opts.onUpdate; return { cancel, stop: async () => "final A" } as StreamingDictation; });
    const f = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Dikte et" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Kaydı durdur" })).toBeTruthy());
    act(() => update("A dictation", ""));
    f.switchTo("43");
    act(() => update("late A dictation", ""));
    expect(input().value).toBe("");
    expect(cancel).toHaveBeenCalledOnce();
    f.switchTo("42");
    expect(input().value).toBe("A dictation");
  });
  it("grounds a meeting conversation with its canonical row even before the list resolves", async () => {
    fixture();
    fireEvent.change(input(), { target: { value: "Summarize this run" } });
    fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].active?.meeting_id).toBe("42");
    expect(screen.queryByRole("button", { name: "Yeni sohbet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sohbet oturumunu değiştir" })).toBeNull();
  });

  it("does not send an attachment turn after its composer has been closed", async () => {
    let finishUpload: (response: unknown) => void = () => {};
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url === "/api/workspace/upload"
      ? new Promise((resolve) => { finishUpload = resolve; })
      : original(url, init)));
    const f = fixture();
    fireEvent.change(input(), { target: { value: "A attachment question" } });
    fireEvent.change(f.container.querySelector('input[type="file"]')!, { target: { files: [new File(["A"], "A.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
    f.switchTo("43");
    fireEvent.change(input(), { target: { value: "B draft" } });
    await act(async () => finishUpload({ ok: true, json: async () => ({ files: [{ name: "A.txt", path: "attachments/A.txt" }] }) }));
    expect(input().value).toBe("B draft");
    expect(requests).toHaveLength(0);
    f.switchTo("42");
    expect(input().value).toBe("A attachment question");
    expect(screen.getByText("A.txt")).toBeTruthy();
  });

  it("reports an unreadable history and does not mark it as an empty successful conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ detail: "denied" }) })));
    fixture();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Sohbet yüklenemedi"));
  });

  it("aborts the previous account's pending stream before it can reconnect as the new account", async () => {
    const f = fixture();
    fireEvent.change(input(), { target: { value: "Private A" } });
    fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    f.switchTo("42", "second-account");
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryByText("Private A")).toBeNull();
  });

  it("loads the durable history for each row in a fresh composer and keeps general chat separate", async () => {
    const sessionA = meetingConversationSession(subject, "42");
    const sessionB = meetingConversationSession(subject, "43");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({
      sessions: [{ session: sessionA, title: "Private meeting" }, { session: "main", title: "General chat" }],
      turns: [{ role: "user", text: url.includes(sessionA) ? "Stored A" : url.includes(sessionB) ? "Stored B" : "Stored general" }],
    }) })));
    const f = fixture();
    await waitFor(() => expect(screen.getByText("Stored A")).toBeTruthy());
    f.switchTo("43");
    await waitFor(() => expect(screen.getByText("Stored B")).toBeTruthy());
    expect(screen.queryByText("Stored A")).toBeNull();
    f.switchTo("42");
    expect(screen.getByText("Stored A")).toBeTruthy();
    f.unmount();
    const layout = createLayoutService("files");
    const container = createContainer([reg(LayoutServiceId, () => layout), reg(CommandServiceId, createCommandService)]);
    render(<ServicesProvider container={container}><Chat params={{ subject }} /></ServicesProvider>);
    await waitFor(() => expect(screen.getByText("Stored general")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sohbet oturumunu değiştir" }));
    expect(screen.queryByRole("menuitemradio", { name: "Private meeting" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "General chat" })).toBeTruthy();
  });

  it("cancels a microphone that finishes acquiring permission after the user leaves", async () => {
    let grant: (recording: StreamingDictation) => void = () => {};
    dictation.start.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const cancel = vi.fn();
    const f = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Dikte et" }));
    f.switchTo("43");
    await act(async () => grant({ cancel, stop: async () => "" } as StreamingDictation));
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Kaydı durdur" })).toBeNull();
  });

  it("cancels the final dictation request when switching away while transcription is pending", async () => {
    let finish: (text: string) => void = () => {};
    const cancel = vi.fn();
    dictation.start.mockResolvedValue({ cancel, stop: () => new Promise<string>((resolve) => { finish = resolve; }) });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const f = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Dikte et" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Kaydı durdur" })).toBeTruthy());
    clock.mockReturnValue(2000);
    fireEvent.click(screen.getByRole("button", { name: "Kaydı durdur" }));
    f.switchTo("43");
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => finish("Final A"));
    expect(input().value).toBe("");
    f.switchTo("42");
    expect(input().value).toBe("");
    clock.mockRestore();
  });

});

it("retains independently removable attachments across a meeting switch without randomUUID", async () => {
  vi.stubGlobal("crypto", {});
  const f = fixture();
  const add = (name: string) => fireEvent.change(f.container.querySelector('input[type="file"]')!, {
    target: { files: [new File([name], name, { type: "text/plain" })] },
  });
  add("first.txt");
  expect(screen.getByText("first.txt")).toBeTruthy();
  f.switchTo("43");
  expect(screen.queryByText("first.txt")).toBeNull();
  f.switchTo("42");
  add("second.txt");
  expect(screen.getByText("first.txt")).toBeTruthy();
  expect(screen.getByText("second.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "first.txt dosyasını kaldır" }));
  expect(screen.queryByText("first.txt")).toBeNull();
  expect(screen.getByText("second.txt")).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("Sohbet yükleniyor…")).toBeNull());
});
