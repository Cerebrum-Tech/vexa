/** Named directory views retain the original workspace/document identity. */
export type DirectoryKind = "person" | "company" | "partner";
export interface DirectoryMount { slug: string; name?: string | null; primary: boolean; write: boolean }
export interface DirectoryRecord {
  id: string; path: string; slug?: string; workspace: string; writable: boolean;
  kind: DirectoryKind; title: string; description: string; organization: string; body: string; source: string;
}
export function isDirectoryCandidate(path: string): boolean {
  return path.startsWith("kg/") && /\.md$/i.test(path) && !/(^|\/)(index|readme|log)\.md$/i.test(path);
}
const text = (s: string) => s.trim().replace(/^["']|["']$/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$1");
export function directoryRecord(path: string, source: string, mount: DirectoryMount): DirectoryRecord | null {
  if (!isDirectoryCandidate(path)) return null;
  const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = Object.fromEntries((front?.[1] ?? "").split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^([\w-]+):\s*(.*)$/); return m ? [[m[1], text(m[2])]] : [];
  }));
  const type = fields.type || fields.kind || path.split("/")[2] || "";
  const kind = ["person", "people"].includes(type) ? "person" : ["company", "organization", "org"].includes(type) ? "company"
    : ["note", "partner", "partner-note", "partner_note"].includes(type) ? "partner" : null;
  if (!kind) return null;
  const body = front ? source.slice(front[0].length) : source;
  const title = fields.title || fields.name || body.match(/^#\s+(.+)$/m)?.[1] || path.split("/").pop()!.replace(/\.md$/i, "").replace(/[-_]/g, " ");
  return { id: JSON.stringify([mount.slug, path]), path, slug: mount.slug,
    workspace: mount.name || (mount.primary ? "Kişisel alanım" : "Paylaşılan alan"), writable: mount.write,
    kind, title, description: fields.description || fields.role || "", organization: fields.company || fields.organization || fields.partner || "", body, source };
}
