/** Report readiness is a producer-stamped artifact, scoped to an authorized workspace and exact run. */
import { listWorkspaceTree, readActiveSet, readMeetingReport, readWorkspaceFile, type ActiveMount } from "../surfaces/workspaceApi";
import type { MeetingMock } from "../surfaces/meetingModel";

export interface ReportTarget { meetingId: string; path: string; workspace?: string }
export interface ReadyReport extends ReportTarget { workspace: string; revision: string; body: string; title?: string }
export const reportPathForRun = (native: string, row: string) => `kg/entities/meeting/${native}.run-${row}.md`;
export const REPORT_TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "past"]);

function scalar(value: string): string {
  const text = value.trim();
  if (text.startsWith('"')) { try { return String(JSON.parse(text)); } catch { return ""; } }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** SHA-256 also runs on self-hosted HTTP origins, where WebCrypto is unavailable. */
async function bodyRevision(body: string): Promise<string> {
  const input = new TextEncoder().encode(body);
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest("SHA-256", input);
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input); padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(input.length * 8 / 0x100000000));
  view.setUint32(padded.length - 4, (input.length * 8) >>> 0);
  const rotate = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));
  const words = new Int32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) | 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + first) | 0; d = c; c = b; b = a; a = (first + second) | 0;
    }
    [a,b,c,d,e,f,g,h].forEach((word, i) => { hash[i] = (hash[i] + word) | 0; });
  }
  return hash.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

export async function parseReadyReport(content: string, target: ReportTarget & { workspace: string }): Promise<ReadyReport | null> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const metadata: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!field) continue;
    if (Object.hasOwn(metadata, field[1])) return null;
    metadata[field[1]] = scalar(field[2]);
  }
  const body = content.slice(match[0].length).trim();
  if (metadata.report_status !== "completed" || metadata.meeting_row_id !== target.meetingId
    || metadata.report_workspace !== target.workspace || !/^[a-f0-9]{64}$/.test(metadata.report_revision ?? "") || !body) return null;
  if (metadata.report_language === "tr" && !["Özet", "Alınan Kararlar", "Aksiyon Maddeleri"].every((heading) => new RegExp(`^## ${heading}\\s*$`, "m").test(body))) return null;
  const revision = await bodyRevision(body);
  if (revision !== metadata.report_revision) return null;
  return { ...target, revision, body, title: metadata.title };
}

function rootsFor(target: ReportTarget, mounts: ActiveMount[], subject: string): ActiveMount[] {
  return mounts.filter((mount) => mount.role !== "system" && mount.role !== "global"
    && (!target.workspace || mount.slug === target.workspace || (target.workspace === subject && mount.primary)));
}

function reportPaths(target: ReportTarget): string[] {
  const suffix = `.run-${target.meetingId}.md`;
  return target.path.endsWith(suffix) ? [target.path, target.path.slice(0, -suffix.length) + ".md"] : [target.path];
}

/** The caller's own mount set first; then the meeting itself, which is the only route to the report of
 *  a meeting SHARED with them — it lives in its owner's workspace and no mount of theirs can reach it. */
export async function readReadyReport(target: ReportTarget): Promise<ReadyReport | null> {
  if (!target.meetingId || !target.path) return null;
  const set = await readActiveSet();
  for (const mount of rootsFor(target, set.active, set.subject)) {
    for (const path of reportPaths(target)) {
      const content = await readWorkspaceFile(path, { slug: mount.slug });
      if (!content) continue;
      const report = await parseReadyReport(content, { ...target, path, workspace: mount.slug });
      if (report) return report;
    }
  }
  const shared = await readMeetingReport(target.meetingId);
  if (!shared || String(shared.meeting_id) !== target.meetingId) return null;
  return parseReadyReport(shared.content, { meetingId: target.meetingId, path: shared.path, workspace: shared.workspace });
}

/** One file read per authorized workspace/path, even for repeated meetings on the same native link. */
export async function scanReadyReports(meetings: MeetingMock[], subject: string): Promise<ReadyReport[]> {
  const set = await readActiveSet();
  if (set.subject !== subject) return [];
  const targets = meetings.filter((meeting) => REPORT_TERMINAL_STATUSES.has(meeting.live_status ?? meeting.status)).map((meeting) => {
    const doc = meeting.docs?.find((item) => ["report", "post-meeting-report"].includes(item.kind ?? ""));
    return { meetingId: meeting.id, path: doc?.path ?? reportPathForRun(meeting.native_id ?? meeting.id, meeting.id), legacyPath: `kg/entities/meeting/${meeting.native_id ?? meeting.id}.md`, workspace: doc?.workspace || meeting.workspace_id, title: meeting.title_custom ?? meeting.title };
  });
  const reports: ReadyReport[] = [];
  for (const mount of set.active.filter((item) => item.role !== "system" && item.role !== "global")) {
    try {
      const tree = new Set(await listWorkspaceTree({ slug: mount.slug }));
      const candidates = targets.filter((target) => rootsFor(target, [mount], subject).length);
      const contents = new Map<string, string | null>();
      for (const target of candidates) {
        for (const path of [...new Set([...reportPaths(target), target.legacyPath])].filter((path) => tree.has(path))) {
          if (!contents.has(path)) contents.set(path, await readWorkspaceFile(path, { slug: mount.slug }));
          const content = contents.get(path);
          if (!content) continue;
          const report = await parseReadyReport(content, { ...target, path, workspace: mount.slug });
          if (report) { reports.push({ ...report, title: target.title }); break; }
        }
      }
    } catch (error) {
      console.warn("report-readiness: authorized workspace scan failed", { workspace: mount.slug, error });
    }
  }
  return reports;
}
