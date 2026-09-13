/**
 * The confirm-loop golden — pins LocalAgreement-N (the shared confirmation core).
 * Moved down from the pipeline now that the engine lives here (@vexa/transcribe-buffer).
 * Run: npm test  (or npx tsx src/local-agreement.test.ts)
 */
import {
  words, longestCommonWordPrefix, commonWordPrefix, localAgreement,
  type AgreementSegment,
} from "./index.js";
import { GmeetCompatibleBuffer } from "./gmeet-compatible-buffer.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failed++;
};

// ── word helpers ────────────────────────────────────────────────────────────
check("words() splits + trims", JSON.stringify(words("  hello   world ")) === JSON.stringify(["hello", "world"]));
check("longestCommonWordPrefix", longestCommonWordPrefix(["a", "b", "c"], ["a", "b", "x"]) === 2);
check("commonWordPrefix across N passes", commonWordPrefix([["a", "b", "c"], ["a", "b", "x"], ["a", "b", "y"]]) === 2);
check("commonWordPrefix empty → 0", commonWordPrefix([]) === 0);
check("commonWordPrefix single pass → full", commonWordPrefix([["a", "b"]]) === 2);

// ── LocalAgreement-N: need `agree` consecutive passes before anything confirms ──
{
  const r = localAgreement([{ text: "hello world", endMs: 1000 }], [], 2000, false, 3);
  check("fewer than `agree` passes → nothing confirms, history carried",
    r.confirmCount === 0 && r.history.length === 1, JSON.stringify(r));
}

// ── confirm a WHOLE stable leading segment once 3 passes agree on its prefix ────
{
  const segments: AgreementSegment[] = [
    { text: "hello world", endMs: 1000 },   // stable across all 3 passes → confirms
    { text: "bar baz", endMs: 1500 },        // still-forming tail → stays pending
  ];
  const history = [["hello", "world", "foo", "qux"], ["hello", "world", "zzz"]]; // prior 2 passes
  const r = localAgreement(segments, history, 2000, false, 3);
  check("3 agreeing passes confirm the whole leading segment (never partial)",
    r.confirmCount === 1 && r.history.length === 0, JSON.stringify(r));
}

// ── closing → everything confirms (last chance) ────────────────────────────────
{
  const r = localAgreement([{ text: "a", endMs: 1 }, { text: "b", endMs: 2 }], [["x"]], 5000, true, 3);
  check("closing confirms all segments", r.confirmCount === 2, JSON.stringify(r));
}

// ── window guard: never confirm a segment overrunning the read audio window ─────
{
  const segments: AgreementSegment[] = [
    { text: "hello world", endMs: 9999 },   // prefix-stable BUT past the read window
    { text: "bar baz", endMs: 9999 },
  ];
  const history = [["hello", "world", "foo"], ["hello", "world", "zzz"]];
  const r = localAgreement(segments, history, 1000, false, 3);  // spanEndMs 1000 ⇒ 9999 overruns
  check("segment past the read window is held (not confirmed)", r.confirmCount === 0, JSON.stringify(r));
}

// ── a text-only STT reply must not lose speech at the hard cap ────────────────────────────────
// gpt-4o-transcribe returns no word or segment times, so every reply is ONE segment covering the
// submitted window and the prefix rule ("confirm only a segment lying entirely inside the stable
// prefix") never fires. The window then grows to the 30s hard cap. The cap flush emits the last
// transcript — which covers audio only up to the last SUBMISSION — and used to reset the buffer,
// discarding the seconds fed since that submission: one ~10-word hole per cap on a read-aloud
// article. Words here have DELIBERATELY uneven durations: any fix that advances the audio by a
// word-count proportion (the even-spread assumption) cuts the audio in the wrong place and shows up
// below as a duplicated or a missing word — exactly what that attempt did in a live meeting.
async function continuousSpeechTextOnly(): Promise<void> {
  const SR = 16000;
  const TOTAL_SEC = 70;                                 // crosses the 30s cap twice
  const DUR = [0.3, 0.7, 0.5, 1.1, 0.4, 0.9, 0.6, 0.35]; // uneven word lengths, cycling
  const words: { w: string; start: number; end: number }[] = [];
  for (let t = 0, i = 0; t < TOTAL_SEC; i++) { const d = DUR[i % DUR.length]; words.push({ w: `w${i + 1}`, start: t, end: t + d }); t += d; }
  const confirmed: string[] = [];
  const capLog: string[] = [];
  let now = 1_000_000;
  let fedSec = 0;
  // The interval timer's tick (trySubmit) is the ONLY path that runs the hard-cap check — a forced
  // or manual request goes straight to submit. Drive that same tick once per 2s frame, with an
  // injected clock, so the cadence is exactly production's and nothing depends on timer jitter.
  const manager = new GmeetCompatibleBuffer({
    minAudioDuration: 2, submitInterval: 2, confirmThreshold: 2, maxBufferDuration: 30, idleTimeoutSec: 60,
    sampleRate: SR, silenceRmsThreshold: 0, scheduleSubmissions: false, flushOnInputGap: false, now: () => now,
    logger: (m) => { if (m.includes("Hard cap")) capLog.push(m); },
  });
  const tick = (manager as unknown as { trySubmit(id: string): Promise<void> }).trySubmit.bind(manager);
  manager.addSpeaker("s", "S");
  manager.onSegmentConfirmed = (_id, _name, text) => { confirmed.push(text); };
  manager.onSegmentReady = (_id, _name, audio) => {
    // The buffer keeps only the un-advanced tail, so the window is the LAST audio.length samples fed.
    // The mock STT hears every word whose START lies inside the window (a word is spoken once).
    const windowSec = audio.length / SR;
    const winStart = fedSec - windowSec;
    const text = words.filter((x) => x.start >= winStart - 1e-9 && x.start < fedSec - 1e-9).map((x) => x.w).join(" ");
    manager.handleTranscriptionResult("s", text, windowSec, [{ text, start: 0, end: windowSec }], "tr");
  };
  const frame = new Float32Array(SR * 2).fill(0.1);
  for (let i = 0; i < TOTAL_SEC / 2; i++) {
    now += 2000; fedSec += 2;
    manager.feedAudio("s", frame, now);
    await tick("s");
  }
  await manager.flushSpeaker("s", true);
  manager.removeAll();

  const got = confirmed.join(" ").split(/\s+/).filter(Boolean);
  const spoken = words.map((x) => x.w);
  const missing = spoken.filter((w) => !got.includes(w));
  const dups = got.filter((w, i) => got.indexOf(w) !== i);
  const inOrder = got.every((w, i) => i === 0 || Number(w.slice(1)) > Number(got[i - 1].slice(1)));
  check("text-only reply across two hard caps: every spoken word reaches the transcript (no hole at the cap)",
    missing.length === 0, `missing ${missing.length}: ${missing.slice(0, 10).join(" ")}`);
  check("text-only reply: no word is transcribed twice (no double-cut duplicates)",
    dups.length === 0, `dups: ${dups.slice(0, 10).join(" ")}`);
  check("text-only reply: words arrive in spoken order", inOrder, got.slice(0, 20).join(" "));
  const kept = capLog.filter((m) => m.includes("Hard cap kept")).length;
  check("text-only reply: the hard cap was crossed and the unheard tail kept (the path under test ran)",
    kept >= 2, `cap log: ${capLog.length} line(s), kept ${kept}`);
}

void continuousSpeechTextOnly().then(() => {
  if (failed) { console.error(`\n❌ local-agreement: ${failed} checks FAILED.`); process.exit(1); }
  console.log(`\n✅ local-agreement: all checks pass — LocalAgreement-N confirms only whole, window-bounded, N-stable prefixes.`);
});
