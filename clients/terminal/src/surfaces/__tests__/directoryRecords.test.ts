import { describe, expect, it } from "vitest";
import { directoryRecord, isDirectoryCandidate } from "../directoryRecords";
const mount = { slug: "team", name: "Satış", primary: false, write: false };
describe("workspace directory records", () => {
  it("excludes indexes and internal configuration from directories", () => {
    expect(isDirectoryCandidate("kg/entities/person/index.md")).toBe(false);
    expect(isDirectoryCandidate("kg/entities/person/log.md")).toBe(false);
    expect(isDirectoryCandidate("agents/meeting.md")).toBe(false);
    expect(isDirectoryCandidate("kg/entities/person/ayse.md")).toBe(true);
  });
  it("leaves the meeting documents out of the crawl a directory pays for", () => {
    expect(isDirectoryCandidate("kg/entities/meeting/218140144714297.md")).toBe(false);
    expect(isDirectoryCandidate("kg/entities/meeting/218140144714297.run-134.md")).toBe(false);
    expect(isDirectoryCandidate("kg/entities/note/asd-mu446jtr.md")).toBe(true);
  });
  it("uses friendly titles and preserves read-only workspace identity", () => {
    const r = directoryRecord("kg/entities/person/ayse.md", "---\ntype: person\ntitle: Ayşe Yılmaz\ncompany: '[[Innova]]'\n---\n# Ayşe\nMerhaba", mount);
    expect(r).toMatchObject({ title: "Ayşe Yılmaz", kind: "person", organization: "Innova", slug: "team", path: "kg/entities/person/ayse.md", writable: false });
  });
  it("keeps equal paths from separate workspaces distinct", () => {
    const a = directoryRecord("kg/entities/company/innova.md", "# Innova", mount)!;
    const b = directoryRecord(a.path, "# Innova", { ...mount, slug: "home", primary: true })!;
    expect(a.id).not.toBe(b.id);
    expect(b.slug).toBe("home");
  });
  it("classifies partner notes without including meeting reports", () => {
    expect(directoryRecord("kg/entities/note/brief.md", "---\ntype: note\ncompany: Innova\ntitle: İş birliği\n---\nNot", mount)?.kind).toBe("partner");
    expect(directoryRecord("kg/entities/meeting/recap.md", "---\ntype: meeting\n---\n# Toplantı", mount)).toBeNull();
  });
});
