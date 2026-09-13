/** Behavioral test for the meetings STORE (liveMeetings.ts), driven over its real seams:
 *    GET /api/meetings (mocked fetch) seeds the rows, then meeting.status frames arrive over the gateway
 *    WS (mocked WebSocket) and patch the store. Pins the WS frame to the ws.v1 golden fixture.
 *
 *  (a) a golden frame patches the matching row by `native` (status flips, no re-snapshot from the frame);
 *  (b) an UNKNOWN-row frame triggers a re-snapshot (extra GET /api/meetings) so a freshly-created
 *      scheduled/idle meeting surfaces.
 *  (c) a WS connect re-snapshots so a missed status frame is repaired by the backend state.
 *
 *  The store is a module singleton, so each test re-imports it fresh (vi.resetModules) and installs its
 *  own fetch + WebSocket fakes BEFORE importing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import golden from "./fixtures/MeetingStatus.scheduled.json";

// The golden's native — the seeded row uses the SAME native so the frame matches by `native`.
const NATIVE = golden.native; // "abc-defg-hij"

function meetingsPayload(status: string) {
  return {
    meetings: [
      {
        id: golden.meeting_id,
        platform: "google_meet",
        native_meeting_id: NATIVE,
        status,
        start_time: null,
        end_time: null,
        data: {},
      },
    ],
  };
}

// A fake WebSocket that captures the store's onmessage handler so the test can push frames.
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.last = this;
    // open on next tick so listeners are wired
    queueMicrotask(() => this.onopen?.());
  }
  close() {}
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  FakeWebSocket.last = null;
  // @ts-expect-error — install the fake transport for the store under test
  globalThis.WebSocket = FakeWebSocket;
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/api/ws")) return jsonResp({ url: "ws://test/ws" });
    if (u.includes("/api/meetings")) return jsonResp(meetingsPayload("idle"));
    return jsonResp({});
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResp(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

async function startStore() {
  const mod = await import("../liveMeetings");
  const hook = renderHook(() => mod.useLiveMeetings());
  // wait until the initial snapshot seeded the row AND the WS opened
  await waitFor(() => {
    expect(hook.result.current.length).toBe(1);
    expect(FakeWebSocket.last).not.toBeNull();
  });
  return { mod, hook };
}

describe("liveMeetings store", () => {
  it("(a) patches the matching row by `native` from a golden frame", async () => {
    const { hook } = await startStore();
    expect(hook.result.current[0].live_status).toBe("idle");
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/meetings")).length;

    await act(async () => {
      FakeWebSocket.last!.push(golden); // status: "scheduled", native: NATIVE
    });

    await waitFor(() => expect(hook.result.current[0].live_status).toBe("scheduled"));
    const row = hook.result.current[0];
    expect(row.native_id).toBe(NATIVE);
    expect(row.scheduled_at).toBe(golden.when); // when carried into scheduled_at
    // patched IN PLACE — the frame itself did not trigger a snapshot fetch.
    const after = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/meetings")).length;
    expect(after).toBe(before);
  });

  it("(b) re-snapshots when the frame targets an UNKNOWN row", async () => {
    const { hook } = await startStore();
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/meetings")).length;

    await act(async () => {
      FakeWebSocket.last!.push({ ...golden, native: "zzz-unknown-row", meeting_id: 999 });
    });

    // unknown row → applyFrame falls through to snapshot() → another GET /api/meetings
    await waitFor(() => {
      const now = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/meetings")).length;
      expect(now).toBe(before + 1);
    });
    // the unknown native did NOT create a phantom row
    expect(hook.result.current.every((m) => m.native_id !== "zzz-unknown-row")).toBe(true);
  });

  it("(c) re-snapshots on WS connect so a missed status advance is repaired", async () => {
    let meetingSnapshots = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/api/meetings")) {
        meetingSnapshots += 1;
        return jsonResp(meetingsPayload(meetingSnapshots === 1 ? "requested" : "active"));
      }
      return jsonResp({});
    });

    const { hook } = await startStore();

    await waitFor(() => expect(hook.result.current[0].live_status).toBe("active"));
    const snapshotCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/meetings"));
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("(e) exposes WS connected-ness: open → true, close → false (stale rows are never silently 'live truth'), reopen → true + re-snapshot", async () => {
    const { mod, hook } = await startStore();
    const conn = renderHook(() => mod.useLiveMeetingsConnection());
    await waitFor(() => expect(conn.result.current).toBe(true));

    // Drive the WS down while an active-looking row is seeded — the store must EXPOSE the drop.
    await act(async () => {
      FakeWebSocket.last!.onclose?.();
    });
    await waitFor(() => expect(conn.result.current).toBe(false));
    // the rows themselves are still served (last snapshot) — but marked as not-live-truth
    expect(hook.result.current.length).toBe(1);

    // Reconnect restores connected AND re-snapshots (repairs any missed frame).
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/meetings")).length;
    await act(async () => {
      FakeWebSocket.last!.onopen?.();
    });
    await waitFor(() => expect(conn.result.current).toBe(true));
    await waitFor(() => {
      const now = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/meetings")).length;
      expect(now).toBeGreaterThan(before);
    });
  });

  it("(d) a 'deleted' frame REMOVES the row (a retired plan never masquerades as Recorded)", async () => {
    const { hook } = await startStore();
    expect(hook.result.current.length).toBe(1);

    await act(async () => {
      FakeWebSocket.last!.push({ ...golden, status: "deleted", when: null });
    });

    await waitFor(() => expect(hook.result.current.length).toBe(0));
  });
});

describe("complete authorized library", () => {
  it("loads page two and retains every canonical recurring run", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://test");
      if (url.pathname !== "/api/meetings") return jsonResp({});
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const count = offset === 0 ? 100 : 2;
      return jsonResp({ meetings: Array.from({ length: count }, (_, i) => ({
        ...meetingsPayload("completed").meetings[0], id: offset + i + 1,
        shared: offset > 0,
      })) });
    });
    const mod = await import("../liveMeetings");
    const hook = renderHook(() => mod.useLiveMeetings());
    await waitFor(() => expect(hook.result.current).toHaveLength(102));
    expect(hook.result.current.at(-1)).toMatchObject({ id: "102", shared: true, native_id: NATIVE });
  });

  it("clears previously authorized rows when a reload is denied", async () => {
    const { mod, hook } = await startStore();
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as Response);
    await act(async () => mod.refreshMeetings());
    await waitFor(() => expect(hook.result.current).toEqual([]));
  });

  it("does not publish a partial library if a later page fails", async () => {
    const { mod, hook } = await startStore();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://test");
      if (Number(url.searchParams.get("offset") ?? 0) > 0) return { ok: false, status: 403 } as Response;
      return jsonResp({ meetings: Array.from({ length: 100 }, (_, i) => ({
        ...meetingsPayload("completed").meetings[0], id: i + 1,
      })) });
    });
    await act(async () => mod.refreshMeetings());
    await waitFor(() => expect(hook.result.current).toEqual([]));
  });

  it("refreshes sharing, dates and attendee names even when status is unchanged", async () => {
    const { mod, hook } = await startStore();
    fetchMock.mockResolvedValue(jsonResp({ meetings: [{ ...meetingsPayload("idle").meetings[0],
      shared: true, start_time: "2026-09-10T10:00:00Z", data: { attendees: [{ email: "a@example.com", name: "Ayşe" }] },
    }] }));
    await act(async () => mod.refreshMeetings());
    await waitFor(() => expect(hook.result.current[0]).toMatchObject({ shared: true, attendees: [{ name: "Ayşe" }] }));
  });
});


const dateLabel = (at: string) => new Date(at).toLocaleString("tr-TR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

it.each(["idle", "requested", "failed"])("uses persisted creation time for a %s meeting without a join time", async (status) => {
  const created = "2026-09-10T09:24:00Z";
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).includes("/api/meetings")
    ? jsonResp({ meetings: [{ ...meetingsPayload(status).meetings[0], created_at: created }] })
    : jsonResp({ url: "ws://test/ws" }));
  const { mod, hook } = await startStore();
  expect(hook.result.current[0].when).toContain(dateLabel(created));
  expect(hook.result.current[0].created_at).toBe(created);
  expect(hook.result.current[0].start_time).toBeUndefined();
  const before = hook.result.current[0].when;
  await act(async () => mod.refreshMeetings());
  expect(hook.result.current[0].when).toBe(before);
});

it("keeps explicit calendar time and refreshes its label when a scheduling frame arrives", async () => {
  const scheduled = "2026-09-15T09:24:00Z";
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).includes("/api/meetings")
    ? jsonResp({ meetings: [{ ...meetingsPayload("scheduled").meetings[0], created_at: "2026-09-10T09:24:00Z", data: { scheduled_at: scheduled } }] })
    : jsonResp({ url: "ws://test/ws" }));
  const { hook } = await startStore();
  expect(hook.result.current[0].when).toBe(dateLabel(scheduled));
  await act(async () => FakeWebSocket.last!.push(golden));
  expect(hook.result.current[0].when).toBe(dateLabel(golden.when));
});

it("falls back from an invalid join timestamp to persisted creation time", async () => {
  const created = "2026-09-10T09:24:00Z";
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).includes("/api/meetings")
    ? jsonResp({ meetings: [{ ...meetingsPayload("completed").meetings[0], start_time: "invalid", created_at: created }] })
    : jsonResp({ url: "ws://test/ws" }));
  const { hook } = await startStore();
  expect(hook.result.current[0].when).toBe(dateLabel(created));
});
