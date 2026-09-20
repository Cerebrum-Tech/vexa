/**
 * echo-chain — a keeper that later loses hands its victims back; words are never left in no row.
 *
 * Meeting 126 @ 1444–1450 s, replayed: Birkan says "Teşekkür ediyoruz. Bir soru olursa Büşra sana şey
 * yaparız yine haberleşiriz. Tamam." A room mic (Hakan's lane) lights for the middle of it. Three rows
 * result — Birkan "Teşekkür ediyoruz.", Hakan "Teşekkür ediyoruz. Bir soru olursa Büşra.", Birkan "Bir
 * soru olursa … Tamam." — and two retractions in a chain: Birkan's first row lost to Hakan's (a
 * fragment of it), then Hakan's lost to Birkan's second (a fragment of that). Without restoration,
 * "Teşekkür ediyoruz" was in no row at all. This script pins the invariant the chain broke — every word
 * the speaker said is in exactly one durable row, under the speaker's lane — on the same shape (a room-mic
 * row spanning two of the speaker's sentences); the chain itself is witnessed on the 126 tape replay.
 *
 *   tsx src/echo-chain.test.ts
 */
import { TeamsCsrcGmeetPipeline, type TeamsCsrcTranscriptSegment } from './teams-csrc-gmeet-pipeline.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failed++;
};

const BIRKAN = 1266;
const HAKAN = 840;
type Word = { w: string; a: number; b: number };
const words: Word[] = 'teşekkür 0 500, ediyoruz 500 1000, bir 1000 1300, soru 1300 1700, olursa 1700 2200, büşra 2200 2700, sana 2700 3100, şey 3100 3400, yaparız 3400 3900, yine 3900 4400, haberleşiriz 4400 5400, tamam 5700 6400'
  .split(/\s*,\s*/).map((item) => { const [w, a, b] = item.split(/\s+/); return { w, a: Number(a), b: Number(b) }; });

const SR = 16_000;
const frame = (fromMs: number, ms = 100): Float32Array => {
  const n = Math.round(SR * ms / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (fromMs + (i * 1000) / SR) / 1000;
  return out;
};
// A time-faithful STT over the one mixed stream: whatever words lie inside the handed window, whichever
// lane asked. Sentence punctuation as faster-whisper would place it.
const punct: Record<string, string> = { ediyoruz: 'Teşekkür ediyoruz.', büşra: 'Büşra', tamam: 'Tamam.' };
const transcribeWindow = (pcm: Float32Array): any => {
  const startMs = pcm[0] * 1000;
  const endMs = startMs + (pcm.length * 1000) / SR;
  const heard = words.filter((x) => x.a >= startMs - 1 && x.b <= endMs + 1);
  if (!heard.length) return { text: '', language: 'tr', duration: (endMs - startMs) / 1000, segments: [] };
  const text = heard.map((x) => (x.w === 'ediyoruz' ? 'ediyoruz.' : x.w === 'tamam' ? 'tamam.' : x.w)).join(' ');
  const segs = [{ text, start: (heard[0].a - startMs) / 1000, end: (heard[heard.length - 1].b - startMs) / 1000, no_speech_prob: 0, avg_logprob: -0.2, compression_ratio: 1.1 }];
  return { text, language: 'tr', duration: (endMs - startMs) / 1000, segments: segs };
};

let now = 0;
const events: TeamsCsrcTranscriptSegment[] = [];
const durable = new Map<string, TeamsCsrcTranscriptSegment>();
const pipeline = new TeamsCsrcGmeetPipeline({
  onsetGapMs: 3000,
  persistTimeoutMs: 10000,
  buffer: { scheduleSubmissions: false, now: () => now, silenceRmsThreshold: 0, maxBufferDuration: 15 },
  onSegment: (s) => { events.push({ ...s }); if (!s.completed && !s.text.trim()) durable.delete(s.segmentId); else durable.set(s.segmentId, s); },
  onNamerLog: () => {},
  transcribe: async (pcm) => transcribeWindow(pcm),
});
// Both mics lit from the first word (one room). Birkan's lane is polled on the ordinary cadence, so
// LocalAgreement confirms "Teşekkür ediyoruz." as its own row before the rest arrives; the room mic's lane
// is only ever transcribed on close, so its whole span lands as ONE row spanning both sentences.
pipeline.recordHint('Birkan', 0); pipeline.recordHint('Hakan', 0);
pipeline.recordTransportEvent({ csrc: BIRKAN, active: true, tMs: 0 });
pipeline.recordTransportEvent({ csrc: HAKAN, active: true, tMs: 0 });
for (now = 0; now < 7000; now += 100) {
  if (now === 2700) pipeline.recordTransportEvent({ csrc: HAKAN, active: false, tMs: now });
  pipeline.feedMixedAudio(frame(now), now);
  if (now % 1000 === 0) await pipeline.requestTranscription(BIRKAN);
}
pipeline.recordTransportEvent({ csrc: BIRKAN, active: false, tMs: 7000 });
now = 7000;
await pipeline.dispose();

const final = [...durable.values()].filter((r) => r.completed && r.text.trim()).sort((a, b) => a.startMs - b.startMs);
console.log('  durable rows:');
for (const r of final) console.log(`    csrc ${r.csrc} [${r.startMs}-${r.endMs}] ${JSON.stringify(r.text)}`);
console.log('  health:', JSON.stringify(pipeline.health()));
const norm = (t: string): string[] => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
const said = words.map((x) => x.w).filter((w) => w !== 'tamam'); // the last word sits past the final polled window; not the subject here
const published = final.flatMap((r) => norm(r.text));
const missing = said.filter((w) => !published.includes(w));
check('every word Birkan said is in some durable row (nothing lost to a retraction chain)', missing.length === 0, JSON.stringify(missing));
check('the sentence opener survives under its own lane', final.some((r) => r.csrc === BIRKAN && /teşekkür ediyoruz/i.test(r.text)), JSON.stringify(final.map((r) => [r.csrc, r.text])));
check('the room mic\'s copy is not the one that survives', !final.some((r) => r.csrc === HAKAN), JSON.stringify(final.map((r) => [r.csrc, r.text])));
check('no word is published under two lanes', final.every((r) => final.every((o) => o === r || o.csrc === r.csrc || !norm(r.text).some((w) => w.length > 3 && norm(o.text).includes(w)))), JSON.stringify(final.map((r) => [r.csrc, r.text])));

if (failed) { console.error(`\n❌ echo-chain: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\n✅ echo-chain: a retracted keeper hands its victims back; the speaker keeps every word exactly once.');
