import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MeetingSourceProvider, useMeeting } from "../useMeeting";
vi.mock("../../surfaces/liveMeetings", () => ({
  useLiveMeetings: () => [
    { id: "41", native_id: "42", title: "Wrong native match", status: "past", transcript: [] },
    { id: "42", native_id: "recurring", title: "Canonical run", status: "past", transcript: [] },
  ],
  fetchDurableTranscript: vi.fn(async () => ({ lines: [], notes: [] })),
  mergeNotesById: (seed: unknown[], live: unknown[]) => [...seed, ...live],
}));
vi.mock("../../surfaces/meetingLive", () => ({ useMeetingLive: () => ({ transcript: [], notes: [], cards: [], errors: [], issues: [], note: "", connected: false, ended: false, reconnects: 0 }) }));
function Probe() { const state = useMeeting(); return <span>{state.meeting.id}:{state.meeting.title}</span>; }
it("resolves exact canonical identity before another row's native identity", () => {
  render(<MeetingSourceProvider meetingId="42"><Probe /></MeetingSourceProvider>);
  expect(screen.getByText("42:Canonical run")).toBeTruthy();
});
