import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryView } from "../directories";
import { Chat } from "../chat";
import { ServicesProvider, createContainer, createCommandService, CommandServiceId, reg } from "../../platform";
import { createLayoutService, LayoutServiceId } from "../../workbench/layout";

vi.mock("../liveMeetings", () => ({ useLiveMeetings: () => [] }));
let serial = 0;
let subject: string;
let saved: string | null;
let requests: { prompt: string; session: string }[];
let streams: ReadableStreamDefaultController<Uint8Array>[];
let documentPath: string;
let storedHistory: string | null;

beforeEach(() => {
  subject = `directory-editor-${++serial}`;
  saved = null; requests = []; streams = []; documentPath = ""; storedHistory = null;
  localStorage.clear();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chat") {
      requests.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start: (c) => streams.push(c) }) };
    }
    let data: unknown = { sessions: [], turns: storedHistory ? [{ role: "user", text: storedHistory }] : [] };
    if (url.startsWith("/api/workspace/active")) data = { subject, active: [{ slug: "team-sales", name: "Satış", primary: true, write: true, role: "private", path: "/workspace/team-sales", repo: null, ref: null }] };
    if (url.startsWith("/api/workspace/tree")) data = { files: saved ? [documentPath] : [] };
    if (url.startsWith("/api/workspace/file")) {
      documentPath = new URL(url, "https://test.local").searchParams.get("path")!;
      if (!saved) return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
      data = { content: saved };
    }
    return { ok: true, status: 200, json: async () => data };
  }));
});
afterEach(() => {
  cleanup();
  for (const stream of streams) { try { stream.close(); } catch {} }
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function fixture(chat = true) {
  const layout = createLayoutService("people"); layout.usePages();
  const container = createContainer([reg(LayoutServiceId, () => layout), reg(CommandServiceId, createCommandService)]);
  const view = (showDirectory = true, identity = subject) => <ServicesProvider container={container}>
    {showDirectory && <DirectoryView id="people" active params={{ directory: "person" }} />}
    {chat && <Chat hideHeader params={{ subject: identity }} />}
  </ServicesProvider>;
  const result = render(view());
  return { ...result, showChatOnly: (identity = subject) => result.rerender(view(false, identity)) };
}
async function fillEditor() {
  await waitFor(() => expect((screen.getByRole("button", { name: "Kişi ekle" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Kişi ekle" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Ad soyad" }), { target: { value: "Ayşe Yılmaz" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Eklemek istediğiniz bilgiler" }), { target: { value: "Satış ekibinde çalışıyor." } });
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Asistanla kaydet" }));

describe("directory editor dispatch", () => {
  it("shows an immediate retryable error when no assistant is mounted", async () => {
    fixture(false); await fillEditor(); save();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Asistan"));
    expect(screen.queryByText(/Belgeye kaydedilmesi bekleniyor/)).toBeNull();
    expect((screen.getByRole("button", { name: "Asistanla kaydet" }) as HTMLButtonElement).disabled).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("rejects a save immediately when the general conversation is already busy", async () => {
    fixture();
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "Önceki soru" } });
    fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await fillEditor(); save();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("yanıt"));
    expect(screen.queryByText(/Belgeye kaydedilmesi bekleniyor/)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("waits for the document, targets its workspace, and keeps targeting out of live and restored history", async () => {
    const f = fixture(); await fillEditor();
    vi.useFakeTimers();
    await act(async () => { save(); });
    expect(requests).toHaveLength(1);
    expect(requests[0].prompt).toContain('Çalışma alanı: "team-sales"');
    expect(requests[0].prompt).toContain(documentPath);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText(/Hedef belge:/)).toBeNull();
    expect(screen.queryByText(/team-sales/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("dialog")).toBeTruthy();
    saved = "---\ntype: person\ntitle: Ayşe Yılmaz\n---\n# Ayşe Yılmaz\nSatış ekibinde çalışıyor.";
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.useRealTimers();
    storedHistory = requests[0].prompt;
    f.showChatOnly(`${subject}-refresh`);
    await waitFor(() => expect(screen.queryByText("Sohbet yükleniyor…")).toBeNull());
    expect(screen.getByText(/Ayşe Yılmaz.*oluştur/)).toBeTruthy();
    expect(screen.queryByText(/Hedef belge:/)).toBeNull();
    expect(screen.queryByText(/team-sales/)).toBeNull();
  });
  it("does not dispatch a stale editor into another conversation after its initial read resolves", async () => {
    const f = fixture(); await fillEditor();
    const originalFetch = globalThis.fetch;
    let finishRead: (response: unknown) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.startsWith("/api/workspace/file")
      ? new Promise((resolve) => { finishRead = resolve; }) : originalFetch(url, init)));
    save();
    f.showChatOnly(`${subject}-next`);
    await act(async () => finishRead({ ok: false, status: 404, json: async () => ({ detail: "not found" }) }));
    expect(requests).toHaveLength(0);
    expect(screen.queryByText(/Ayşe Yılmaz/)).toBeNull();
  });

});
