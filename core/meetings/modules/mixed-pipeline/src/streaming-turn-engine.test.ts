/**
 * StreamingTurnEngine against a fake streaming transcriber: deltas become one growing pending row,
 * a sentence-end pause cuts a confirmed row with the server's text, a long pause cuts mid-sentence,
 * the turn's flush commits the rest, and a foreign-script row is dropped.
 */
import { StreamingTurnEngine, type StreamingTranscriber, type StreamingTranscriberHandlers } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

class FakeStreamer implements StreamingTranscriber {
  pendingText = '';
  opened = false; closed = false; commits = 0; fedSamples = 0;
  nextCompleted: string | null = null;
  constructor(public key: string, public handlers: StreamingTranscriberHandlers) {}
  open() { this.opened = true; }
  feed(pcm: Float32Array) { this.fedSamples += pcm.length; }
  delta(d: string) { this.pendingText += d; this.handlers.onDelta(d); }
  async commit() { this.commits++; const t = this.nextCompleted ?? this.pendingText; this.pendingText = ''; this.nextCompleted = null; return t; }
  close() { this.closed = true; }
}

async function main(): Promise<void> {
  let now = 10_000;
  const streamers = new Map<string, FakeStreamer>();
  const pending: Array<[string, string, number]> = [];
  const confirmed: Array<[string, string, number, number, string]> = [];
  const engine = new StreamingTurnEngine({
    now: () => now, quietMs: 700, silenceCutMs: 1500, language: 'tr',
    createTranscriber: (key, handlers) => { const s = new FakeStreamer(key, handlers); streamers.set(key, s); return s; },
  });
  engine.onSegmentPending = (key, _n, text, startMs) => pending.push([key, text, startMs]);
  engine.onSegmentConfirmed = (key, _n, text, startMs, endMs, id) => confirmed.push([key, text, startMs, endMs, id]);

  const frame = new Float32Array(3200).fill(0.1);   // 200 ms
  engine.addSpeaker('csrc-201:1', 'CSRC 201');
  const s = streamers.get('csrc-201:1')!;
  check('addSpeaker opens one streaming session for the turn', s.opened && engine.getActiveSpeakers().length === 1);
  engine.feedAudio('csrc-201:1', frame, 1000);
  engine.feedAudio('csrc-201:1', frame, 1200);
  check('audio is forwarded as-is (no window, no re-submission)', s.fedSamples === 6400, `${s.fedSamples}`);
  s.delta(' Merhaba'); now += 300; s.delta(' arkadaşlar.');
  check('deltas publish ONE growing pending row starting at the first audio of the row',
    pending.length === 2 && pending[1][1] === 'Merhaba arkadaşlar.' && pending[0][2] === 1000 && pending[1][2] === 1000, JSON.stringify(pending));
  engine.feedAudio('csrc-201:1', frame, 1400);
  check('a sentence end with no pause yet is NOT cut', s.commits === 0 && confirmed.length === 0);
  now += 800;                                   // quiet for 800 ms after the sentence end
  s.nextCompleted = 'Merhaba, arkadaşlar.';     // the server's canonical text
  engine.feedAudio('csrc-201:1', frame, 1600);  // the tick that notices the pause
  await new Promise((r) => setTimeout(r, 0));
  check('a sentence end followed by a quiet pause cuts a confirmed row with the server\'s text and the row\'s audio span',
    s.commits === 1 && confirmed.length === 1 && confirmed[0][1] === 'Merhaba, arkadaşlar.' && confirmed[0][2] === 1000 && confirmed[0][3] === 1800
      && confirmed[0][4] === 'csrc-201:1:0', JSON.stringify(confirmed));
  check('the confirmed text is what getLastConfirmedText reports', engine.getLastConfirmedText('csrc-201:1') === 'Merhaba, arkadaşlar.');
  // next row: no sentence end, but a long silence
  engine.feedAudio('csrc-201:1', frame, 2000);
  s.delta(' bugün gündem'); now += 1600;
  engine.feedAudio('csrc-201:1', frame, 2200);
  await new Promise((r) => setTimeout(r, 0));
  check('a long pause cuts even mid-sentence (the row starts at the first audio after the previous cut)',
    confirmed.length === 2 && confirmed[1][1] === 'bugün gündem' && confirmed[1][2] === 2000, JSON.stringify(confirmed.slice(1)));
  // foreign script is dropped, and the pending row cleared
  engine.feedAudio('csrc-201:1', frame, 3000);
  s.delta(' 삶을 바라보는'); s.nextCompleted = '삶을 바라보는.';
  const before = pending.length;
  await engine.flushSpeaker('csrc-201:1', true);
  check('a row written in a script the forced language does not use is dropped and its draft cleared',
    confirmed.length === 2 && s.commits === 3 && pending.length === before + 1 && pending[pending.length - 1][1] === '', JSON.stringify(pending.slice(-1)));
  // flush commits the remainder; remove closes the session
  engine.feedAudio('csrc-201:1', frame, 4000);
  s.delta(' son söz'); s.nextCompleted = 'Son söz.';
  await engine.flushSpeaker('csrc-201:1', true);
  check('the turn\'s flush commits what is left as a confirmed row', confirmed.length === 3 && confirmed[2][1] === 'Son söz.' && confirmed[2][2] === 4000, JSON.stringify(confirmed.slice(-1)));
  // continuous speech: a long row is cut at a sentence end WITHOUT waiting for a pause…
  engine.addSpeaker('csrc-201:2', 'CSRC 201');
  const s2 = streamers.get('csrc-201:2')!;
  const before2 = confirmed.length;
  for (let t = 10_000; t < 16_400; t += 200) { engine.feedAudio('csrc-201:2', frame, t); if (t % 1000 === 0) { now += 200; s2.delta(' söz'); } }
  s2.delta(' bitti.'); now += 300;            // sentence end, only 300 ms quiet, row holds 6.6 s of audio
  s2.nextCompleted = 'söz söz söz söz söz söz söz bitti.';
  engine.feedAudio('csrc-201:2', frame, 16_400);
  await new Promise((r) => setTimeout(r, 0));
  check('a row past the eager threshold is cut at a sentence end without a pause',
    confirmed.length === before2 + 1 && confirmed[before2][1].endsWith('bitti.'), JSON.stringify(confirmed.slice(-1)));
  // …and a row with no sentence end at all is cut at the next word boundary once it is very long
  const before3 = confirmed.length;
  for (let t = 16_600; t < 32_000; t += 200) { engine.feedAudio('csrc-201:2', frame, t); if (t % 1000 === 0) { now += 200; s2.delta(' kelime'); } }
  now += 300; s2.nextCompleted = 'kelime kelime kelime';
  engine.feedAudio('csrc-201:2', frame, 32_000);
  await new Promise((r) => setTimeout(r, 0));
  check('a very long row without punctuation is cut at a word boundary (max-row rule)',
    confirmed.length === before3 + 1 && confirmed[before3][1] === 'kelime kelime kelime', JSON.stringify(confirmed.slice(-1)));
  engine.removeSpeaker('csrc-201:2');

  engine.removeSpeaker('csrc-201:1');
  check('removeSpeaker closes the session and forgets the turn', s.closed && engine.getActiveSpeakers().length === 0);
  check('a forced requestTranscription on an unknown turn is a no-op', (await engine.requestTranscription('nope', true)) === false);
}

main().then(() => {
  if (failed) { console.error(`\n❌ streaming-turn-engine: ${failed} checks FAILED.`); process.exit(1); }
  console.log('\n✅ streaming-turn-engine: deltas → one growing draft; pauses and flushes → confirmed rows; foreign script dropped.');
});
