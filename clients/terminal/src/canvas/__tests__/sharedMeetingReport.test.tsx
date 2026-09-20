import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readReadyReport } from "../reportReadiness";
import { ShareSessionButton } from "../../surfaces/meeting";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const BODY = `## Özet\n\nBir özet.\n\n## Alınan Kararlar\n\n- Karar.\n\n## Aksiyon Maddeleri\n\n- Aksiyon.`;
/** sha256 of BODY, computed by the same helper the reader uses. */
async function revisionOf(body: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
const report = (revision: string, workspace: string) =>
  `---\ntype: meeting\nmeeting_row_id: '149'\nreport_workspace: ${workspace}\nreport_status: completed\nreport_language: tr\nreport_revision: ${revision}\n---\n\n${BODY}\n`;

let calls: string[];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a meeting shared with me", () => {
  beforeEach(() => { calls = []; });

  it("reads its report from the meeting when no mount of mine holds it", async () => {
    const revision = await revisionOf(BODY);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith("/api/workspace/active")) {
        return { ok: true, status: 200, json: async () => ({ subject: "3", active: [
          { slug: "seed", name: "Benim", primary: true, write: true, role: "private", path: "/workspaces/3", repo: null, ref: null }] }) };
      }
      // My own workspace genuinely does not have it — the report lives in its OWNER's.
      if (url.startsWith("/api/workspace/file")) return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
      if (url === "/api/meeting/149/report") {
        return { ok: true, status: 200, json: async () => ({
          meeting_id: "149", workspace: "seed", path: "kg/entities/meeting/268388393189834.run-149.md",
          revision, content: report(revision, "seed") }) };
      }
      throw new Error(`unexpected ${url}`);
    }));
    const ready = await readReadyReport({ meetingId: "149", path: "kg/entities/meeting/268388393189834.run-149.md" });
    expect(ready?.body).toContain("Alınan Kararlar");
    expect(calls).toContain("/api/meeting/149/report");
  });

  it("stays null when the meeting refuses it, instead of waiting forever on a report that never comes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/workspace/active")) {
        return { ok: true, status: 200, json: async () => ({ subject: "3", active: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({ detail: "yok" }) };
    }));
    expect(await readReadyReport({ meetingId: "149", path: "kg/entities/meeting/x.run-149.md" })).toBeNull();
  });

  it("never accepts a report bound to a different meeting row", async () => {
    const revision = await revisionOf(BODY);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/workspace/active")) {
        return { ok: true, status: 200, json: async () => ({ subject: "3", active: [] }) };
      }
      if (url === "/api/meeting/149/report") {
        return { ok: true, status: 200, json: async () => ({
          meeting_id: "999", workspace: "seed", path: "kg/entities/meeting/x.run-999.md",
          revision, content: report(revision, "seed") }) };
      }
      return { ok: false, status: 404, json: async () => ({ detail: "yok" }) };
    }));
    expect(await readReadyReport({ meetingId: "149", path: "kg/entities/meeting/x.run-149.md" })).toBeNull();
  });
});

describe("share popover placement", () => {
  it("opens from the button's left edge and never wider than the viewport", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
    const { container } = render(<ShareSessionButton platform="teams" native="268388393189834" />);
    fireEvent.click(screen.getByRole("button", { name: /Oturumu paylaş/ }));
    const panel = [...container.querySelectorAll<HTMLDivElement>("div")]
      .find((node) => node.style.position === "absolute")!;
    expect(panel).toBeTruthy();
    // Anchored right, a 280px panel opens leftwards and slides under the sidebar on a narrow window.
    expect(panel.style.left).toBe("0px");
    expect(panel.style.right).toBe("");
    expect(panel.style.maxWidth).toBe("calc(100vw - 24px)");
  });
});
