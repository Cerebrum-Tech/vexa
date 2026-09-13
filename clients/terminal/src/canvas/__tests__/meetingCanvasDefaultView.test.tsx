import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";

/** Corrected default, raw access, explicit opt-out, owner controls and failed-save feedback. */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const durableState: { lines: unknown[]; notes: unknown[] } = { lines: [], notes: [] };
let meetingsState: unknown[] = [];

vi.mock("../../surfaces/liveMeetings", () => ({
  useLiveMeetings: () => meetingsState,
  fetchDurableTranscript: vi.fn(async () => ({ lines: durableState.lines, notes: durableState.notes })),
  mergeNotesById: (seed: { id: string }[], live: { id: string }[]) => [...seed, ...live],
}));

vi.mock("../../surfaces/meetingLive", () => ({
  useMeetingLive: () => ({
    transcript: [], notes: [], cards: [], errors: [], issues: [], note: "",
    connected: false, ended: false, reconnects: 0,
  }),
}));

vi.mock("../../surfaces/workspaceApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../surfaces/workspaceApi")>(),
  readWorkspaceFile: vi.fn(async () => null),
  readActiveSet: vi.fn(async () => ({ subject: "u_jane", active: [{ slug: "u_jane", role: "private", primary: true }] })),
}));

import { MeetingCanvasView } from "../MeetingCanvasView";
import { defaultProcessingView } from "../processingView";
import { ServicesProvider, createContainer, reg } from "../../platform";
import { LayoutServiceId, createLayoutService } from "../../workbench/layout";
import * as workspaceApi from "../../surfaces/workspaceApi";

const NOTE = { id: "n1", speaker: "Jane", text: "We agreed to ship Friday.", t: 1, pass: 1 };
const LINE = { speaker: "Jane", text: "so um we agreed to ship friday", t: 1 };

function meetingRow(live: boolean) {
  return {
    id: "abc-defg-hij", native_id: "abc-defg-hij",
    session_uid: live ? "abc-defg-hij" : undefined,
    title: "Google Meet · abc-defg-hij", when: "", status: live ? "live" : "past",
    platform: "Google Meet", participants: [], mentioned: [], actions: [], transcript: [], insights: [],
  };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(workspaceApi.readWorkspaceFile).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function renderCanvas(transcript = true, initialSection?: "summary" | "transcript") {
  root = createRoot(container);
  const container2 = createContainer([reg(LayoutServiceId, () => createLayoutService("meetings"))]);
  await act(async () => {
    root.render(
      <ServicesProvider container={container2}>
        <MeetingCanvasView meetingId="abc-defg-hij" initialSection={initialSection} />
      </ServicesProvider>,
    );
  });
  if (transcript) {
    await act(async () => { Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) => b.textContent === "Transkript")?.click(); });
  }
  // flush the async durable hydration
  await act(async () => { await Promise.resolve(); });
}

function toggleButton(): HTMLButtonElement {
  return container.querySelector("button[aria-pressed]") as HTMLButtonElement;
}

function processCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/meeting/process")).length;
}

it("opens the recording transcript directly when requested by the upload action", async () => {
  meetingsState = [meetingRow(false)];
  durableState.lines = [LINE]; durableState.notes = [];
  await renderCanvas(false, "transcript");
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Transkript");
  expect(processCalls()).toBe(0);
});

describe("defaultProcessingView (pure)", () => {
  it("raw for live and completed meetings regardless of hydration", () => {
    expect(defaultProcessingView(false, true)).toBe(false);
    expect(defaultProcessingView(false, false)).toBe(false);
    expect(defaultProcessingView(true, true)).toBe(false);
    expect(defaultProcessingView(true, false)).toBe(false);
  });
});

describe("MeetingCanvasView — default view + toggle semantics", () => {
  it("toplantı bitince Türkçe raporu kullanıcı komutu olmadan gösterir", async () => {
    meetingsState = [meetingRow(false)];
    durableState.lines = [LINE];
    durableState.notes = [NOTE];
    const body = "## Özet\n\nYayın planı görüşüldü.\n\n## Alınan Kararlar\n\nCuma günü yayın yapılacak.\n\n## Aksiyon Maddeleri\n\n- Jane: Sürümü hazırlayacak.";
    const report = `---\nmeeting_row_id: abc-defg-hij\nreport_workspace: u_jane\nreport_status: completed\nreport_language: tr\nreport_revision: ${createHash("sha256").update(body).digest("hex")}\n---\n\n${body}`;
    vi.mocked(workspaceApi.readWorkspaceFile).mockImplementation(async (path) =>
      path === "kg/entities/meeting/abc-defg-hij.run-abc-defg-hij.md" ? report : null,
    );

    await renderCanvas(false);

    await waitFor(() => expect(container.textContent).toContain("Yayın planı görüşüldü."));
    expect(container.textContent).toContain("Alınan Kararlar");
    expect(container.textContent).toContain("Jane: Sürümü hazırlayacak.");
  });

  it("COMPLETED meeting defaults to the RAW view even when corrected notes exist", async () => {
    meetingsState = [meetingRow(false)];
    durableState.lines = [LINE];
    durableState.notes = [NOTE];
    await renderCanvas();
    const btn = toggleButton();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toContain("Ham");
    expect(container.textContent).toContain("Ham transkript");
  });

  it("COMPLETED meeting without notes shows raw and keeps access to corrected", async () => {
    meetingsState = [meetingRow(false)];
    durableState.lines = [LINE];
    durableState.notes = [];
    await renderCanvas();
    const btn = toggleButton();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Ham transkript");
  });

  it("LIVE meeting defaults to raw even when notes exist", async () => {
    meetingsState = [meetingRow(true)];
    durableState.lines = [LINE];
    durableState.notes = [NOTE];
    await renderCanvas();
    const btn = toggleButton();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toContain("Ham");
  });

  it("COMPLETED meeting toggle is a pure view switch — never calls the arm endpoint", async () => {
    meetingsState = [meetingRow(false)];
    durableState.lines = [LINE];
    durableState.notes = [NOTE];
    await renderCanvas();
    const btn = toggleButton();
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true"); // flipped to corrected
    await act(async () => { toggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false"); // back to raw
    expect(processCalls()).toBe(0);
  });

  it("LIVE meeting toggle still arms the copilot via /api/meeting/process", async () => {
    meetingsState = [meetingRow(true)];
    durableState.lines = [];
    durableState.notes = [];
    await renderCanvas();
    await act(async () => { toggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(toggleButton().textContent).toContain("Düzeltilmiş");
    expect(processCalls()).toBe(1);
  });
});


describe("explicit correction preference", () => {
  it("keeps ON after reopening the same canonical meeting", async () => {
    meetingsState = [meetingRow(true)]; durableState.lines = [LINE]; durableState.notes = [NOTE];
    await renderCanvas();
    await act(async () => { toggleButton().click(); });
    await act(async () => { root.unmount(); });
    await renderCanvas();
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/meeting/process"));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ on: true });
  });
  it("shows a failed toggle and retains the confirmed view", async () => {
    meetingsState = [meetingRow(true)]; durableState.lines = [LINE]; durableState.notes = [NOTE];
    fetchMock.mockImplementation(async (url) => new Response("{}", { status: String(url).includes("/api/meeting/process") ? 503 : 200 }));
    await renderCanvas();
    await act(async () => { toggleButton().click(); });
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("değiştirilemedi"));
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
  });
});

it("offers summary, transcript and meeting preparation notes as separate sections", async () => {
  meetingsState = [meetingRow(false)]; durableState.lines = [LINE]; durableState.notes = [NOTE];
  await renderCanvas();
  expect(container.querySelector('[role="tablist"]')?.textContent).toContain("Özet");
  const notes = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) => b.textContent === "Notlar")!;
  await act(async () => notes.click());
  expect(container.textContent).toContain("Hazırlık notları");
  expect(container.textContent).not.toContain("We agreed to ship Friday.");
});

it("shared live viewers can switch raw/corrected without changing the owner's processing preference", async () => {
  meetingsState = [{ ...meetingRow(true), shared: true }]; durableState.lines = [LINE]; durableState.notes = [NOTE];
  await renderCanvas();
  await act(async () => toggleButton().click());
  expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
  expect(processCalls()).toBe(0);
});
