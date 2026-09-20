import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryView, EntityEditor } from "../directories";
import { Chat } from "../chat";
import { ServicesProvider, createContainer, createCommandService, CommandServiceId, reg } from "../../platform";
import { createLayoutService, LayoutServiceId } from "../../workbench/layout";

vi.mock("../liveMeetings", () => ({ useLiveMeetings: () => [] }));
let serial = 0;
let subject: string;
let saved: string | null;
let savedPath: string;
let chatRequests: number;
let entityWrites: { workspace: string; kind: string; title: string; body: string; path?: string }[];
let writeFailure: { status: number; detail: string } | null;
let streams: ReadableStreamDefaultController<Uint8Array>[];
let directoryReads: number;

beforeEach(() => {
  subject = `directory-editor-${++serial}`;
  saved = null; savedPath = ""; chatRequests = 0; entityWrites = []; writeFailure = null; streams = []; directoryReads = 0;
  localStorage.clear();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chat") {
      chatRequests += 1;
      return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start: (c) => streams.push(c) }) };
    }
    if (url === "/api/workspace/entity") {
      const body = JSON.parse(String(init?.body));
      entityWrites.push(body);
      if (writeFailure) return { ok: false, status: writeFailure.status, json: async () => ({ detail: writeFailure!.detail }) };
      savedPath = body.path ?? `kg/entities/${body.kind}/kaydedilen-1a2b3c.md`;
      saved = `---\ntype: ${body.kind}\nid: 1a2b3c\ntitle: "${body.title}"\n---\n\n${body.body}\n`;
      return { ok: true, status: 201, json: async () => ({ workspace: body.workspace, kind: body.kind, path: savedPath, content: saved }) };
    }
    const mount = { slug: "team-sales", name: "Satış", primary: true, write: true, role: "private", path: "/workspace/team-sales", repo: null, ref: null };
    let data: unknown = { sessions: [], turns: [] };
    if (url.startsWith("/api/workspace/active")) data = { subject, active: [mount] };
    if (url.startsWith("/api/workspace/entities")) {
      directoryReads += 1;
      data = { subject, mounts: [mount], unreadable: [], truncated: false,
               files: saved ? [{ slug: mount.slug, path: savedPath, content: saved }] : [] };
    }
    if (url.startsWith("/api/workspace/file")) {
      if (!saved) return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
      data = { content: saved };
    }
    return { ok: true, status: 200, json: async () => data };
  }));
});
afterEach(() => {
  cleanup();
  for (const stream of streams) { try { stream.close(); } catch { /* already closed */ } }
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function fixture() {
  const layout = createLayoutService("people"); layout.usePages();
  const container = createContainer([reg(LayoutServiceId, () => layout), reg(CommandServiceId, createCommandService)]);
  return render(<ServicesProvider container={container}>
    <DirectoryView id="people" active params={{ directory: "person" }} />
    <Chat hideHeader params={{ subject }} />
  </ServicesProvider>);
}
async function fillEditor(name = "Ayşe Yılmaz", notes = "Satış ekibinde çalışıyor.") {
  await waitFor(() => expect((screen.getByRole("button", { name: "Kişi ekle" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Kişi ekle" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Ad soyad/ }), { target: { value: name } });
  fireEvent.change(screen.getByRole("textbox", { name: /Notlar/ }), { target: { value: notes } });
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

describe("directory editor", () => {
  it("writes the card the person typed, without asking the assistant anything", async () => {
    fixture(); await fillEditor(); save();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(entityWrites).toEqual([{ workspace: "team-sales", kind: "person",
                                    title: "Ayşe Yılmaz", body: "Satış ekibinde çalışıyor." }]);
    // The claim that matters: no model turn was spent reproducing what the form already held.
    expect(chatRequests).toBe(0);
    // And a directory refresh is ONE request, not one per document — hundreds per refresh is what
    // met the gateway's per-user guard as a 429.
    expect(directoryReads).toBeGreaterThan(0);
    expect(directoryReads).toBeLessThanOrEqual(3);
  });

  it("shows the card once it is saved", async () => {
    fixture(); await fillEditor(); save();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Ayşe Yılmaz" })).toBeTruthy());
  });

  it("keeps the cards on screen when a refresh fails, and does not call a saved card a failure", async () => {
    fixture(); await fillEditor(); save();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Ayşe Yılmaz" })).toBeTruthy());
    // The backend goes away AFTER the card is on screen — a restart, a dropped request.
    const before = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith("/api/workspace/entities")
        ? Promise.reject(new TypeError("Failed to fetch")) : (before as typeof fetch)(url, init)));
    fireEvent.click(screen.getByRole("button", { name: "Kişi ekle" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Ad soyad/ }), { target: { value: "Zeynep Kaya" } });
    save();
    await waitFor(() => expect(entityWrites).toHaveLength(2));
    // The card that was already listed is still listed, and the save is not reported as a failure.
    expect(screen.getByRole("heading", { name: "Ayşe Yılmaz" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("son başarılı okumadan"));
    expect(screen.queryByText(/Bilgiler yüklenemedi/)).toBeNull();
  });

  it("keeps the form open and says why when the workspace refuses the write", async () => {
    writeFailure = { status: 403, detail: "Bu çalışma alanına yazma yetkiniz yok." };
    fixture(); await fillEditor(); save();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("yazma yetkiniz yok"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Kaydet" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("edits an existing card in place instead of filing a second one", async () => {
    const mount = { slug: "team-sales", name: "Satış", primary: true, write: true, role: "private",
                    path: "/workspace/team-sales", repo: null, ref: null };
    const record = { id: "x", path: "kg/entities/person/ayse-1a2b3c.md", slug: "team-sales",
                     workspace: "Satış", writable: true, kind: "person" as const, title: "Ayşe Yılmaz",
                     description: "", organization: "", body: "# Ayşe Yılmaz\nSatışta.",
                     source: "" };
    render(<EntityEditor kind="person" mounts={[mount]} record={record} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: /Notlar/ }), { target: { value: "Artık pazarlamada." } });
    save();
    await waitFor(() => expect(entityWrites).toHaveLength(1));
    // The card keeps its own path, so a re-save updates it rather than filing a second copy.
    expect(entityWrites[0].path).toBe(record.path);
    expect(entityWrites[0].body).toBe("Artık pazarlamada.");
  });

  it("opens an existing card's editor on the text the card already holds", () => {
    const mount = { slug: "team-sales", name: "Satış", primary: true, write: true, role: "private",
                    path: "/workspace/team-sales", repo: null, ref: null };
    const record = { id: "x", path: "kg/entities/company/innova-1a2b3c.md", slug: "team-sales",
                     workspace: "Satış", writable: true, kind: "company" as const, title: "Innova",
                     description: "", organization: "", body: "# Innova\nAnkara ofisi.", source: "" };
    render(<EntityEditor kind="company" mounts={[mount]} record={record} onClose={() => {}} onSaved={() => {}} />);
    expect((screen.getByRole("textbox", { name: /Notlar/ }) as HTMLTextAreaElement).value).toBe("Ankara ofisi.");
  });
});
