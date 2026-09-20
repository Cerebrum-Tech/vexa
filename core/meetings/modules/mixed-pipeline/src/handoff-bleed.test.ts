/**
 * handoff-bleed — the tail of one lane must not be re-published as the head of the next.
 *
 * Meeting 126 (Teams, 6 named lanes, real STT): when speaker B's CSRC lit while A was finishing a
 * sentence, B's lane opened with the onset lookback and transcribed A's last words as its own
 * first row — "robot bakımından. Orada" under Birkan, 0.9 s after the same words closed Murat's
 * row. 17 such rows in 24 minutes, none retracted: the word-contest never saw them.
 *
 *   tsx src/handoff-bleed.test.ts
 */
import { TeamsCsrcGmeetPipeline, type TeamsCsrcTranscriptSegment } from './teams-csrc-gmeet-pipeline.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failed++;
};

const A = 1053; // Murat
const B = 1266; // Birkan
let now = 0;
const rows: TeamsCsrcTranscriptSegment[] = [];
const durable = new Map<string, TeamsCsrcTranscriptSegment>();

// One mixed stream, two voices. Every word has its absolute time on the tape; a frame's samples
// carry that time (seconds), so the fake STT below transcribes exactly the audio it is handed —
// no more (nothing the buffer already trimmed), no less — the way a perfect backend would.
type Word = { w: string; a: number; b: number; who: number };
const W = (who: number, spec: string): Word[] => spec.trim().split(/\s*,\s*/).map((item) => {
  const [w, a, b] = item.split(/\s+/); return { w, a: Number(a), b: Number(b), who };
});
const words: Word[] = [
  // A: 0–7.0 s, "bir ödeme stratejisinde yardımcı olacak bir robot bakımından orada şöyle oluyor"
  ...W(A, 'bir 0 400, ödeme 400 1000, stratejisinde 1000 1900, yardımcı 1900 2600, olacak 2600 3500, bir 3500 3800, robot 3800 4300, bakımından 4300 5300, orada 5300 6000, şöyle 6000 6500, oluyor 6500 7000'),
  // B: from 7.1 s, "şimdi bizim zaten diğer projeler de ondan takıldı burada kurgulanan bu tarz sistemleri"
  ...W(B, 'şimdi 7100 7500, bizim 7500 7900, zaten 7900 8300, diğer 8300 8700, projeler 8700 9300, de 9300 9500, ondan 9500 9900, takıldı 9900 10500, burada 10600 11000, kurgulanan 11000 11800, bu 11800 12000, tarz 12000 12400, sistemleri 12400 13000'),
].sort((x, y) => x.a - y.a);

const SR = 16_000;
const frame = (fromMs: number, ms = 100): Float32Array => {
  const n = Math.round(SR * ms / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (fromMs + (i * 1000) / SR) / 1000;
  return out;
};
const seg = (text: string, start: number, end: number): any => ({ text, start, end, no_speech_prob: 0, avg_logprob: -0.2, compression_ratio: 1.1 });
const transcribeWindow = (pcm: Float32Array): any => {
  const startMs = pcm[0] * 1000;
  const endMs = startMs + (pcm.length * 1000) / SR;
  const heard = words.filter((x) => x.a >= startMs - 1 && x.b <= endMs + 1);
  // one segment per speaker run, times relative to the window (no word times, like faster-whisper here)
  const segs: any[] = [];
  for (const x of heard) {
    const last = segs[segs.length - 1];
    if (last && last.who === x.who) { last.text += ' ' + x.w; last.end = (x.b - startMs) / 1000; }
    else segs.push({ ...seg(x.w, (x.a - startMs) / 1000, (x.b - startMs) / 1000), who: x.who });
  }
  return { text: segs.map((s) => s.text).join(' '), language: 'tr', duration: (endMs - startMs) / 1000, segments: segs.map(({ who: _w, ...s }) => s) };
};

const pipeline = new TeamsCsrcGmeetPipeline({
  buffer: { scheduleSubmissions: false, now: () => now, silenceRmsThreshold: 0 },
  onSegment: (s) => {
    rows.push(s);
    if (!s.completed && !s.text.trim()) durable.delete(s.segmentId);
    else durable.set(s.segmentId, s);
  },
  onNamerLog: () => {},
  transcribe: async (pcm) => transcribeWindow(pcm),
});

// Transport: A lit 0–7.0 s; B lit from 6.0 s (Teams lights the next speaker while the current
// sentence is still ending — 126: 1.0 s of overlap on the "robot bakımından. Orada" pair).
pipeline.recordTransportEvent({ csrc: A, active: true, tMs: 0 });
const submitAt = new Set([2000, 4000, 6000, 8000, 10000, 12000]);
for (now = 0; now < 13000; now += 100) {
  if (now === 6000) pipeline.recordTransportEvent({ csrc: B, active: true, tMs: now });
  if (now === 7000) pipeline.recordTransportEvent({ csrc: A, active: false, tMs: now });
  pipeline.feedMixedAudio(frame(now), now);
  if (submitAt.has(now)) for (const c of pipeline.activeCsrcs()) await pipeline.requestTranscription(c);
}
now = 13000;
await pipeline.dispose();

const final = [...durable.values()].filter((r) => r.completed && r.text.trim()).sort((a, b) => a.startMs - b.startMs);
console.log('  durable rows:');
for (const r of final) console.log(`    csrc ${r.csrc} [${r.startMs}-${r.endMs}] ${JSON.stringify(r.text)}`);
console.log('  health:', JSON.stringify(pipeline.health()));
const aTail = final.filter((r) => r.csrc === A).map((r) => r.text).join(' ');
const bleed = final.filter((r) => r.csrc === B && aTail.includes(r.text.replace(/[.,]/g, '').trim()));
check("A's confirmed text carries its own sentence end", /şöyle oluyor/.test(aTail), aTail);
check("B publishes its own speech", final.some((r) => r.csrc === B && /şimdi bizim/.test(r.text)), JSON.stringify(final.map((r) => r.text)));
check("B never publishes a row that is only A's tail", bleed.length === 0, JSON.stringify(bleed.map((r) => r.text)));
check('the bleed copy was retracted by a contest or an echo, never rewritten',
  pipeline.health().resolvedContests + pipeline.health().resolvedEchoes >= 1, JSON.stringify(pipeline.health()));
check('a retraction reached the sink under the bleed row\'s own id',
  rows.some((r) => r.csrc === B && !r.completed && !r.text.trim()), JSON.stringify(rows.map((r) => [r.csrc, r.completed, r.text.slice(0, 20)])));

if (failed) { console.error(`\n❌ handoff-bleed: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\n✅ handoff-bleed: a lane opened on the onset lookback does not republish the previous lane\'s tail.');
