import { beforeEach, describe, expect, it } from "vitest";
import { createLayoutService } from "../layout";
import { registry } from "../../contributions";

const meeting = (id: string) => ({ id: `meeting:${id}`, title: "Toplantı", kind: "meeting", params: { meetingId: id } });
describe("page navigation", () => {
  beforeEach(() => localStorage.clear());
  it("opens one page without a docking host and returns to the library", () => {
    const layout = createLayoutService("meetings");
    layout.usePages();
    expect(layout.store.getState().page?.kind).toBe("today");
    layout.openPreview(meeting("12"));
    expect(layout.store.getState().activeTab?.params.meetingId).toBe("12");
    layout.openTab(meeting("13"));
    expect(layout.store.getState().page?.id).toBe("meeting:13");
    expect(layout.goBack()).toBe(true);
    expect(layout.store.getState().page?.id).toBe("meeting:12");
    layout.goBack();
    expect(layout.store.getState().page?.kind).toBe("today");
  });
  it("retargets a document and preserves back navigation", () => {
    const layout = createLayoutService("meetings");
    layout.usePages();
    layout.openTab({ id: "doc:a", title: "Ayşe", kind: "doc", params: { path: "a.md", slug: "team" } });
    layout.retargetTab("doc:a", { id: "doc:b", title: "Bora", kind: "doc", params: { path: "b.md", slug: "team" } });
    expect(layout.store.getState().page?.params).toEqual({ path: "b.md", slug: "team" });
    layout.goBack();
    expect(layout.store.getState().page?.params?.path).toBe("a.md");
  });
  it("does not restore private page content from a previous login", () => {
    const a = createLayoutService("meetings"); a.usePages(); a.openTab(meeting("12"));
    const b = createLayoutService("meetings"); b.usePages();
    expect(b.store.getState().page?.kind).toBe("today");
    expect(b.store.getState().rightCollapsed).toBe(true);
  });
  it("restores the previous section after settings and preserves an exact meeting notification", () => {
    const layout = createLayoutService("meetings"); layout.usePages();
    layout.openTab({ id: "settings", title: "Ayarlar", kind: "settings" });
    layout.setActiveList("settings", false);
    layout.goBack();
    expect(layout.store.getState()).toMatchObject({ activeList: "meetings", page: { kind: "today" } });
    layout.openTab(meeting("12"));
    layout.setActiveList("meetings", false);
    expect(layout.store.getState().page?.params?.meetingId).toBe("12");
  });
  it("opens registered sections through the command palette's setActiveList path", () => {
    registry.registerList({ id: "people", label: "Kişiler", icon: "user", order: 30, component: () => null,
      centerTab: { id: "people", title: "Kişiler", kind: "directory", params: { directory: "person" } } });
    const layout = createLayoutService("meetings"); layout.usePages();
    layout.setActiveList("people");
    expect(layout.store.getState().page?.params?.directory).toBe("person");
    layout.goBack();
    expect(layout.store.getState().page?.kind).toBe("today");
  });
});
