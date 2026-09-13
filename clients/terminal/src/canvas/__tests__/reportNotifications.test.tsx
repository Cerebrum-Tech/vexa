import { webcrypto, createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportNotifications, REPORT_POLL_MS } from "../ReportNotifications";
import type { MeetingMock } from "../../surfaces/meetingModel";
import * as workspaceApi from "../../surfaces/workspaceApi";

let meetings: MeetingMock[] = [];
vi.mock("../../surfaces/liveMeetings", () => ({ useLiveMeetings: () => meetings }));
vi.mock("../../surfaces/workspaceApi", () => ({ readActiveSet: vi.fn(), listWorkspaceTree: vi.fn(), readWorkspaceFile: vi.fn() }));
const path = "kg/entities/meeting/recurring.md";
function report(row = "42", body = "## Özet\nYeni özet.\n\n## Alınan Kararlar\nKarar yok.\n\n## Aksiyon Maddeleri\nAksiyon yok.") {
  return `---\nmeeting_row_id: '${row}'\nreport_workspace: team\nreport_status: completed\nreport_language: tr\nreport_revision: ${createHash("sha256").update(body).digest("hex")}\n---\n\n${body}`;
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  meetings = [{ id: "42", native_id: "recurring", title: "Plan görüşmesi", when: "", status: "past", live_status: "completed", platform: "teams", participants: [], mentioned: [], actions: [], transcript: [], insights: [] }];
  vi.mocked(workspaceApi.readActiveSet).mockResolvedValue({ subject: "alice", active: [{ slug: "team", path: "/work/team", role: "reader", write: false, primary: false, repo: null, ref: null }] });
  vi.mocked(workspaceApi.listWorkspaceTree).mockResolvedValue([path]);
  vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue(report());
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("global report notifications", () => {
  it("keeps the newest three toasts from a six-report batch while retaining every unread menu item", async () => {
    meetings = Array.from({ length: 6 }, (_, index) => ({
      ...meetings[0], id: String(index + 1), native_id: `run-${index + 1}`,
      title: `Görüşme ${index + 1} — uzun toplantı başlığı`,
    }));
    vi.mocked(workspaceApi.listWorkspaceTree).mockResolvedValue(
      meetings.map((meeting) => `kg/entities/meeting/${meeting.native_id}.run-${meeting.id}.md`),
    );
    vi.mocked(workspaceApi.readWorkspaceFile).mockImplementation(async (file) => {
      const row = file.match(/\.run-(\d+)\.md$/)?.[1];
      return row ? report(row) : null;
    });
    render(<ReportNotifications subject="alice" onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("6 okunmamış bildirim")).toBeTruthy());
    const notices = screen.getAllByRole("status");
    expect(notices).toHaveLength(3);
    expect(notices.map((notice) => notice.textContent)).toEqual([
      expect.stringContaining("Görüşme 4"), expect.stringContaining("Görüşme 5"), expect.stringContaining("Görüşme 6"),
    ]);
    expect(notices[0].parentElement?.style.maxHeight).toBe("50dvh");
    expect(notices[0].parentElement?.style.overflowY).toBe("auto");
    fireEvent.click(screen.getByRole("button", { name: "Bildirimler" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(6);
    expect(screen.getByRole("menuitem", { name: /Görüşme 1/ })).toBeTruthy();
    expect(screen.getByLabelText("6 okunmamış bildirim")).toBeTruthy();
  });

  it("observes a durable report without meeting detail, marks it read and opens the canonical row", async () => {
    const onOpen = vi.fn();
    render(<ReportNotifications subject="alice" onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Toplantı özeti hazır"));
    fireEvent.click(screen.getByRole("button", { name: "Bildirimler" }));
    expect(screen.getByRole("menu").textContent).toContain("Plan görüşmesi");
    fireEvent.click(screen.getByRole("menuitem", { name: /Plan görüşmesi/ }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("42"));
    expect(screen.queryByLabelText("1 okunmamış bildirim")).toBeNull();
  });

  it("retains unread state across reload, without announcing the same revision twice", async () => {
    const first = render(<ReportNotifications subject="alice" onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    first.unmount();
    render(<ReportNotifications subject="alice" onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("1 okunmamış bildirim")).toBeTruthy());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("notifies when a report arrives on a later poll and removes notices when workspace access disappears", async () => {
    vi.useFakeTimers();
    vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue(null);
    render(<ReportNotifications subject="alice" onOpen={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByRole("status")).toBeNull();
    vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue(report());
    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_MS); });
    // WebCrypto completes outside fake timers.
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    vi.mocked(workspaceApi.readActiveSet).mockResolvedValue({ subject: "alice", active: [] });
    meetings = [...meetings];
    cleanup();
    render(<ReportNotifications subject="alice" onOpen={() => {}} />);
    await waitFor(() => expect(screen.queryByLabelText("1 okunmamış bildirim")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Bildirimler" }));
    expect(screen.getByRole("menu").textContent).not.toContain("Plan görüşmesi");
  });

  it("does not show another account's cached unread items", async () => {
    const first = render(<ReportNotifications subject="alice" onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    vi.mocked(workspaceApi.readActiveSet).mockResolvedValue({ subject: "bob", active: [] });
    first.rerender(<ReportNotifications subject="bob" onOpen={() => {}} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByLabelText("1 okunmamış bildirim")).toBeNull();
  });
});
