import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingCanvasView } from "../MeetingCanvasView";
import { ServicesProvider, createContainer, reg } from "../../platform";
import { createLayoutService, LayoutServiceId } from "../../workbench/layout";

const fixtures = vi.hoisted(() => ({ meetings: [] as unknown[] }));
vi.mock("../../surfaces/liveMeetings", () => ({
  useLiveMeetings: () => fixtures.meetings,
  fetchDurableTranscript: async () => ({ lines: [], notes: [] }),
  mergeNotesById: () => [],
}));
vi.mock("../../surfaces/meetingLive", () => ({ useMeetingLive: () => ({
  transcript: [], notes: [], cards: [], errors: [], issues: [], note: "",
  connected: false, ended: false, reconnects: 0,
}) }));

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ subject: "user", active: [], files: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const path = "kg/entities/meeting/weekly-plan.md";
function row(id: string, workspace: string) {
  return { id, native_id: "weekly-plan", status: "past", live_status: "completed", title: "Haftalık plan", platform: "teams", when: "",
    participants: [], mentioned: [], actions: [], transcript: [], insights: [],
    docs: [{ path, workspace, kind: "brief", title: "Hazırlık" }],
  };
}

describe("meeting preparation document identity", () => {
  it("opens each brief in its recorded workspace when two workspaces contain the same path", async () => {
    fixtures.meetings = [row("42", "personal"), row("43", "shared-team")];
    const layout = createLayoutService("meetings"); layout.usePages();
    const services = createContainer([reg(LayoutServiceId, () => layout)]);
    const view = (id: string) => <ServicesProvider container={services}><MeetingCanvasView meetingId={id} /></ServicesProvider>;
    const f = render(view("42"));
    fireEvent.click(screen.getByRole("tab", { name: "Notlar" }));
    fireEvent.click(screen.getByRole("button", { name: "Hazırlık notunu aç" }));
    expect(layout.store.getState().page?.params).toEqual({ path, slug: "personal" });
    const firstId = layout.store.getState().page?.id;
    await act(async () => f.rerender(view("43")));
    fireEvent.click(screen.getByRole("tab", { name: "Notlar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Hazırlık notunu aç" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Hazırlık notunu aç" }));
    expect(layout.store.getState().page?.params).toEqual({ path, slug: "shared-team" });
    expect(layout.store.getState().page?.id).not.toBe(firstId);
  });
});
