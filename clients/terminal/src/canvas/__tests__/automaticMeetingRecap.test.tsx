import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";

/** The recap panel reads the path the WORKER writes.
 *
 *  The post-meeting write turn names the meeting entity with the native meeting id verbatim —
 *  `kg/entities/meeting/<native>.md` (core/agent/worker/meeting.py). A native id is opaque: a Teams id
 *  (`19:meeting_AbC-dEf_123@thread.v2`) carries `:`, `_`, `@` and `.`, so any client-side reshaping of it
 *  addresses a file that does not exist. Google Meet codes survive such reshaping unchanged, which is why
 *  only Teams meetings lose their report — these tests hold both shapes.
 *
 *  Also covered: the bounded wait budget. The report is authored MINUTES after the stop — a long
 *  meeting is summarized in chunks and then written from those digests — so the panel polls fast at
 *  first and then patiently, and when the budget runs out it reports NOT READY rather than FAILED.
 *  The 90-second budget it replaced declared failure on essentially every real meeting, including
 *  ones whose report landed correctly moments later. */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let meetingsState: unknown[] = [];

vi.mock("../../surfaces/liveMeetings", () => ({
  useLiveMeetings: () => meetingsState,
  fetchDurableTranscript: vi.fn(async () => ({ lines: [], notes: [] })),
  mergeNotesById: (seed: unknown[], live: unknown[]) => [...seed, ...live],
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
}));

import { AutomaticMeetingRecap, FAST_ATTEMPTS, MAX_ATTEMPTS, RETRY_DELAY_MS, SLOW_RETRY_DELAY_MS, retryDelayMs } from "../AutomaticMeetingRecap";
import { MeetingSourceProvider, useMeeting, useMeetingDocs } from "../useMeeting";

const SLOW_MS = SLOW_RETRY_DELAY_MS;
import * as workspaceApi from "../../surfaces/workspaceApi";

const TEAMS_NATIVE = "19:meeting_AbC-dEf_123@thread.v2";
const MEET_NATIVE = "abc-defg-hij";
const REPORT = "---\ntype: meeting\n---\n\n## Özet\n\nYayın planı görüşüldü.\n\n## Alınan Kararlar\n\nCuma günü yayın yapılacak.\n\n## Aksiyon Maddeleri\n\n- Jane: Sürümü hazırlayacak.";

function meetingRow(opts: { id: string; native: string; platform: string; docs?: unknown[] }) {
  return {
    id: opts.id, native_id: opts.native,
    title: `${opts.platform} · ${opts.native}`, when: "", status: "past", live_status: "completed",
    platform: opts.platform, participants: [], mentioned: [], actions: [], transcript: [], insights: [],
    docs: opts.docs ?? [],
  };
}

/** The real composition MeetingCanvasView performs: the docs hook resolves the path, the recap reads it. */
function RecapProbe() {
  const meeting = useMeeting();
  const docs = useMeetingDocs();
  return (
    <>
      <div data-testid="report-path">{docs.report.path}</div>
      <AutomaticMeetingRecap status={meeting.meeting.status} reportPath={docs.report.path} />
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.mocked(workspaceApi.readWorkspaceFile).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
});

async function renderProbe(meetingId: string) {
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MeetingSourceProvider meetingId={meetingId}>
        <RecapProbe />
      </MeetingSourceProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
}

function reportPath(): string {
  return container.querySelector("[data-testid=report-path]")?.textContent ?? "";
}

function readPaths(): string[] {
  return vi.mocked(workspaceApi.readWorkspaceFile).mock.calls.map(([path]) => String(path));
}

describe("recap path — the worker's name, verbatim", () => {
  it("Teams: reads kg/entities/meeting/<native>.md with the raw native id", async () => {
    meetingsState = [meetingRow({ id: "42", native: TEAMS_NATIVE, platform: "Microsoft Teams" })];
    vi.mocked(workspaceApi.readWorkspaceFile).mockImplementation(async (path) =>
      path === `kg/entities/meeting/${TEAMS_NATIVE}.md` ? REPORT : null,
    );

    await renderProbe("42");

    expect(reportPath()).toBe(`kg/entities/meeting/${TEAMS_NATIVE}.md`);
    await waitFor(() => expect(container.textContent).toContain("Yayın planı görüşüldü."));
    expect(container.textContent).toContain("Alınan Kararlar");
    // negative control: no reshaped spelling of the native id is ever requested
    expect(readPaths()).toEqual([`kg/entities/meeting/${TEAMS_NATIVE}.md`]);
    expect(readPaths().some((p) => p.includes("19-meeting-abc-def-123-thread-v2"))).toBe(false);
  });

  it("Google Meet: the same rule keeps the code unchanged", async () => {
    meetingsState = [meetingRow({ id: "7", native: MEET_NATIVE, platform: "Google Meet" })];
    vi.mocked(workspaceApi.readWorkspaceFile).mockImplementation(async (path) =>
      path === `kg/entities/meeting/${MEET_NATIVE}.md` ? REPORT : null,
    );

    await renderProbe("7");

    expect(reportPath()).toBe(`kg/entities/meeting/${MEET_NATIVE}.md`);
    await waitFor(() => expect(container.textContent).toContain("Yayın planı görüşüldü."));
  });

  it("a recorded doc ref wins over the deterministic default", async () => {
    const recorded = `kg/entities/meeting/${TEAMS_NATIVE}.md`;
    meetingsState = [meetingRow({
      id: "42", native: TEAMS_NATIVE, platform: "Microsoft Teams",
      docs: [{ workspace: "u_jane", path: recorded, title: TEAMS_NATIVE, kind: "meeting" }],
    })];
    vi.mocked(workspaceApi.readWorkspaceFile).mockImplementation(async (path) => (path === recorded ? REPORT : null));

    await renderProbe("42");

    expect(reportPath()).toBe(recorded);
    await waitFor(() => expect(container.textContent).toContain("Yayın planı görüşüldü."));
  });
});

describe("recap wait budget", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("waits long enough for a report that takes minutes, then says NOT READY — not failed", async () => {
    meetingsState = [meetingRow({ id: "42", native: TEAMS_NATIVE, platform: "Microsoft Teams" })];
    vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue(null);

    await renderProbe("42");

    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(container.textContent).toContain("Özet hazırlanıyor…");

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(retryDelayMs(attempt - 1)); });
      expect(vi.mocked(workspaceApi.readWorkspaceFile)).toHaveBeenCalledTimes(attempt + 1);
    }

    // NOT an alert, and not the word "failed": the copilot may still be writing, and on a long
    // meeting it usually is.
    expect(container.querySelector("[role=alert]")).toBeNull();
    const status = container.querySelector("[role=status]")?.textContent ?? "";
    expect(status).toContain("henüz hazır değil");
    expect(status).not.toContain("oluşturulamadı");
    expect(container.textContent).not.toContain("Özet hazırlanıyor…");
    // the budget is still BOUNDED: no further poll is scheduled after it is spent
    await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_MS * 5); });
    expect(vi.mocked(workspaceApi.readWorkspaceFile)).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("the budget is measured in minutes, because that is how long the report takes", () => {
    // The replaced budget was 90 s. A 77-minute meeting's report needs chunk summaries plus the
    // write turn — minutes of model time — so a budget shorter than that only ever reported a lie.
    let total = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) total += retryDelayMs(i);
    expect(total).toBeGreaterThan(15 * 60_000);
    expect(retryDelayMs(0)).toBe(RETRY_DELAY_MS);              // fast while a quick report is plausible
    expect(retryDelayMs(FAST_ATTEMPTS)).toBeGreaterThan(RETRY_DELAY_MS);  // then patient
  });

  it("a file that is not the Turkish report keeps the panel waiting", async () => {
    meetingsState = [meetingRow({ id: "42", native: TEAMS_NATIVE, platform: "Microsoft Teams" })];
    vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue("---\ntype: meeting\n---\n\n## Attendees\n\n- [[Jane]]");

    await renderProbe("42");

    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS); });
    expect(container.textContent).toContain("Özet hazırlanıyor…");
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(vi.mocked(workspaceApi.readWorkspaceFile)).toHaveBeenCalledTimes(2);
  });
});
