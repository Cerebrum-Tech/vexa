import { webcrypto, createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseReadyReport, readReadyReport, scanReadyReports } from "../reportReadiness";
import type { MeetingMock } from "../../surfaces/meetingModel";
import * as workspaceApi from "../../surfaces/workspaceApi";

vi.mock("../../surfaces/workspaceApi", () => ({ readActiveSet: vi.fn(), listWorkspaceTree: vi.fn(), readWorkspaceFile: vi.fn() }));
const body = "## Özet\nPlan görüşüldü.\n\n## Alınan Kararlar\nKarar yok.\n\n## Aksiyon Maddeleri\nAksiyon yok.";
const revision = createHash("sha256").update(body).digest("hex");
const content = (fields = "") => `---\ntype: meeting\nmeeting_row_id: '42'\nreport_workspace: team\nreport_status: completed\nreport_language: tr\nreport_revision: ${revision}\n${fields}---\n\n${body}\n`;
const target = { meetingId: "42", workspace: "team", path: "kg/entities/meeting/recurring.md" };
const row = (id = "42"): MeetingMock => ({ id, native_id: "recurring", title: "Plan", when: "", status: "past", live_status: "completed", platform: "teams", participants: [], mentioned: [], actions: [], transcript: [], insights: [] });

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.mocked(workspaceApi.readActiveSet).mockResolvedValue({ subject: "alice", active: [{ slug: "team", path: "/work/team", role: "reader", write: false, primary: false, repo: null, ref: null }] });
  vi.mocked(workspaceApi.listWorkspaceTree).mockResolvedValue([target.path]);
  vi.mocked(workspaceApi.readWorkspaceFile).mockReset().mockResolvedValue(content());
});

describe("report provenance", () => {
  it("accepts the producer's exact run/workspace and verifies the body revision", async () => {
    expect(await parseReadyReport(content(), target)).toMatchObject({ body, revision, meetingId: "42", workspace: "team" });
    expect(await parseReadyReport(content(), { ...target, meetingId: "43" })).toBeNull();
    expect(await parseReadyReport(content(), { ...target, workspace: "another" })).toBeNull();
    expect(await parseReadyReport(content().replace("Plan görüşüldü.", "Changed body"), target)).toBeNull();
  });

  it("verifies reports on HTTP installations without WebCrypto", async () => {
    vi.stubGlobal("crypto", {});
    expect(await parseReadyReport(content(), target)).toMatchObject({ body, revision });
  });

  it("rejects preparation, unstamped old reports, failed generation and empty sections", async () => {
    expect(await parseReadyReport(`---\ntype: meeting\n---\n${body}`, target)).toBeNull();
    expect(await parseReadyReport(content().replace("completed", "failed"), target)).toBeNull();
    expect(await parseReadyReport(content().replace("## Özet", "## Hazırlık"), target)).toBeNull();
  });

  it("discovers private reports only in authorized mounts and never treats recurring rows as one run", async () => {
    const reports = await scanReadyReports([row(), row("43")], "alice");
    expect(reports.map((report) => report.meetingId)).toEqual(["42"]);
    expect(workspaceApi.readWorkspaceFile).toHaveBeenCalledWith(target.path, { slug: "team" });
    expect(await scanReadyReports([row()], "bob")).toEqual([]);
  });

  it("does not infer workspace authorization from a transcript share or an inaccessible file", async () => {
    expect(await scanReadyReports([{ ...row(), shared: true, workspace_id: "private-owner-workspace" }], "alice")).toEqual([]);
    vi.mocked(workspaceApi.readWorkspaceFile).mockRejectedValue(new Error("403"));
    expect(await scanReadyReports([row()], "alice")).toEqual([]);
    vi.mocked(workspaceApi.readWorkspaceFile).mockResolvedValue(null);
    expect(await scanReadyReports([row()], "alice")).toEqual([]);
  });
});


it("reads a run snapshot first and accepts a legacy fallback only for the exact run", async () => {
  const run = { ...target, path: "kg/entities/meeting/recurring.run-42.md" };
  vi.mocked(workspaceApi.readWorkspaceFile).mockImplementation(async (path) => path === target.path ? content() : null);
  expect(await readReadyReport(run)).toMatchObject({ meetingId: "42", path: target.path });
  expect(await readReadyReport({ ...run, meetingId: "43", path: "kg/entities/meeting/recurring.run-43.md" })).toBeNull();
  vi.mocked(workspaceApi.listWorkspaceTree).mockResolvedValue([run.path, target.path]);
  vi.mocked(workspaceApi.readWorkspaceFile).mockImplementation(async (path) => path === target.path ? content() : "unready snapshot");
  expect(await scanReadyReports([row()], "alice")).toHaveLength(1);
});
