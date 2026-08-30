/** Smoke tests for the Workspace PAGE (workspaceManage.tsx) — the center tab a WORKSPACES row opens.
 *  Locks the README-first shape: the workspace README is the page body; management is a compact header
 *  ("Paylaş" primary action + ⋯ menu with Arşivle/Sil) and the deeper sections (Amaç · GitHub ·
 *  Üyeler) fold behind one "Çalışma alanını yönet" toggle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { ServicesProvider, createContainer, reg } from "../../platform";
import { LayoutServiceId, createLayoutService } from "../../workbench/layout";
import * as api from "../workspaceApi";

vi.mock("../workspaceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workspaceApi")>()),
  readAttachedWorkspaces: vi.fn(),
  readActiveSet: vi.fn(),
  listSharedMemberships: vi.fn(),
  gitRemoteStatus: vi.fn(),
  readWorkspacePurpose: vi.fn(),
  readWorkspaceFile: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  pushWorkspace: vi.fn(),
  publishWorkspace: vi.fn(),
  shareEnableWorkspace: vi.fn(),
  mintInvite: vi.fn(),
}));

// import AFTER the mock is registered (importing the module also registers the "workspace" tab-kind)
import { manageTabDescriptor } from "../workspaceManage";
import { registry } from "../../contributions";

const container = () => createContainer([reg(LayoutServiceId, () => createLayoutService("files"))]);
const renderPanel = (params: Record<string, unknown>) => {
  const Comp = registry.tabComponent("workspace")!;  // the panel registered as the "workspace" tab-kind
  return render(<ServicesProvider container={container()}><Comp id="workspace:x" params={params} active /></ServicesProvider>);
};
const expandManage = async () => fireEvent.click(await screen.findByText("Çalışma alanını yönet"));

beforeEach(() => {
  // seed slot is a different workspace, so `acme-1234` is a NON-seed own slot (archive/delete allowed).
  vi.mocked(api.readAttachedWorkspaces).mockResolvedValue({ active: "seed", slots: { "acme-1234": { repo: "https://github.com/me/acme.git", ref: "main", name: "ACME deal" } } } as never);
  vi.mocked(api.readActiveSet).mockResolvedValue({ subject: "u1", active: [{ slug: "acme-1234", repo: null, ref: null, role: "private", path: "/w", write: true, primary: true }] } as never);
  vi.mocked(api.listSharedMemberships).mockResolvedValue([]);
  vi.mocked(api.readWorkspacePurpose).mockResolvedValue("The ACME deal room.");
  vi.mocked(api.readWorkspaceFile).mockResolvedValue("# ACME\n\nThe deal dashboard body.");
  vi.mocked(api.gitRemoteStatus).mockResolvedValue({ has_home: true, remote: "origin", url: "https://github.com/me/acme", branch: "main", tracked: true, ahead: 2, behind: 0 } as never);
  vi.mocked(api.listWorkspaceMembers).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("manageTabDescriptor", () => {
  it("own workspace → kind 'workspace', id by slug, slug param", () => {
    expect(manageTabDescriptor("acme-1234", { name: "ACME deal" })).toMatchObject({ kind: "workspace", id: "workspace:acme-1234", params: { slug: "acme-1234", shared: false } });
  });
  it("shared workspace → id namespaced + shared flag", () => {
    expect(manageTabDescriptor("wsid-9", { shared: true })).toMatchObject({ id: "workspace:shared:wsid-9", params: { slug: "wsid-9", shared: true } });
  });
});

describe("WorkspaceManagePanel — own workspace with a GitHub home", () => {
  it("renders the README as the page body, sync state in the meta row, sections folded", async () => {
    renderPanel({ slug: "acme-1234", shared: false, name: "ACME deal" });
    expect(await screen.findByText("ACME deal")).toBeTruthy();                    // header name
    expect(await screen.findByText(/The deal dashboard body/)).toBeTruthy();      // README = the body
    expect(screen.getByText("↑2")).toBeTruthy();                                  // sync state in the meta row
    expect(screen.getByText("Paylaş")).toBeTruthy();                              // primary header action
    expect(screen.queryByText("Amaç")).toBeNull();                                // sections folded by default
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("the manage fold unfolds Amaç, GitHub (Gönder/Çek), participants CTA", async () => {
    renderPanel({ slug: "acme-1234", shared: false, name: "ACME deal" });
    await expandManage();
    expect(await screen.findByText("The ACME deal room.")).toBeTruthy();  // purpose loaded
    expect(screen.getByText("Amaç")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Gönder/)).toBeTruthy()); // has_home → push/pull
    expect(screen.getByText(/Çek/)).toBeTruthy();
    expect(screen.getByText("Bu çalışma alanını paylaş")).toBeTruthy();   // not shared yet → CTA
  });

  it("⋯ menu carries Rename / Manage / Archive / Delete (the old Danger zone)", async () => {
    renderPanel({ slug: "acme-1234", shared: false, name: "ACME deal" });
    await screen.findByText("ACME deal");
    fireEvent.click(screen.getByTitle("Yeniden adlandır · Yönet · Arşivle · Sil"));
    expect(screen.getByText("Yeniden adlandır")).toBeTruthy();
    expect(screen.getByText("Arşivle")).toBeTruthy();
    expect(screen.getByText("Sil")).toBeTruthy();
  });

  it("Push reveals a token field and pushes with the entered token", async () => {
    vi.mocked(api.pushWorkspace).mockResolvedValue({ remote: "origin", url: "u", branch: "main", head_sha: "abc" } as never);
    renderPanel({ slug: "acme-1234", shared: false, name: "ACME deal" });
    await expandManage();
    await waitFor(() => screen.getByText(/Gönder/));
    fireEvent.click(screen.getByText(/Gönder/).closest("button")!);
    const tok = await screen.findByPlaceholderText(/GitHub belirteci/);
    fireEvent.change(tok, { target: { value: "ghp_test" } });
    fireEvent.keyDown(tok, { key: "Enter" });
    await waitFor(() => expect(api.pushWorkspace).toHaveBeenCalledWith({ slug: "acme-1234", token: "ghp_test" }));
  });

  it("a workspace WITHOUT a git home gets the Publish CTA, publishing with its slug", async () => {
    vi.mocked(api.gitRemoteStatus).mockResolvedValue({ has_home: false, remote: null, url: null, branch: "master", tracked: false, ahead: 0, behind: 0 } as never);
    vi.mocked(api.publishWorkspace).mockResolvedValue({ repo_url: "https://github.com/me/acme", pushed_ref: "master", head_sha: "abc", created: true } as never);
    renderPanel({ slug: "acme-1234", shared: false, name: "ACME deal" });
    await expandManage();
    fireEvent.click(await screen.findByText("GitHub’da yayımla…"));
    const tok = screen.getByPlaceholderText(/GitHub belirteci/);
    fireEvent.change(tok, { target: { value: "ghp_x" } });
    fireEvent.click(screen.getByText("Yayımla"));
    // slug rides along so the backend publishes THIS workspace, not the seed
    await waitFor(() => expect(api.publishWorkspace).toHaveBeenCalledWith("acme-deal", true, "ghp_x", undefined, "acme-1234"));
  });

  it("header Share enables sharing and opens the invite MODAL (portaled — never lost below a long README)", async () => {
    vi.mocked(api.shareEnableWorkspace).mockResolvedValue({ workspace_id: "acme-ws-1" } as never);
    vi.mocked(api.mintInvite).mockResolvedValue({ token: "tok123" } as never);
    renderPanel({ slug: "acme-1234", shared: false, name: "ACME deal" });
    await screen.findByText("ACME deal");
    fireEvent.click(screen.getByText("Paylaş").closest("button")!);
    await waitFor(() => expect(api.shareEnableWorkspace).toHaveBeenCalledWith("acme-1234"));
    const dialog = await screen.findByRole("dialog");                     // a real modal, not an inline row
    fireEvent.click(within(dialog).getByText("Bağlantı oluştur"));
    await waitFor(() => expect(api.mintInvite).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: "acme-ws-1", mode: "open" })));
    expect((within(dialog).getByDisplayValue(/invite=tok123/) as HTMLInputElement).value).toContain("tok123");  // copyable link minted in place
  });
});

describe("WorkspaceManagePanel — a shared workspace (member view)", () => {
  it("meta row shows membership; Manage lists members + a Leave affordance", async () => {
    vi.mocked(api.listSharedMemberships).mockResolvedValue([{ workspace_id: "deal-9", role: "contributor" }] as never);
    vi.mocked(api.gitRemoteStatus).mockResolvedValue({ has_home: false, remote: null, url: null, branch: "main", tracked: false, ahead: 0, behind: 0 } as never);
    vi.mocked(api.listWorkspaceMembers).mockResolvedValue([
      { subject: "u_owner", role: "owner" }, { subject: "u_me", role: "contributor" },
    ] as never);
    renderPanel({ slug: "deal-9", shared: true, name: "deal-9" });
    expect(await screen.findByText("2 üye")).toBeTruthy();                   // header meta row
    expect(screen.getByText(/paylaşılan · üye/)).toBeTruthy();
    await expandManage();
    expect(await screen.findByText("Üyeler")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("oluşturan")).toBeTruthy()); // owner role → "oluşturan" badge
    expect(screen.getByText("üye")).toBeTruthy();                            // contributor → "üye"
    expect(screen.getByText("Ayrıl")).toBeTruthy();
  });
});
