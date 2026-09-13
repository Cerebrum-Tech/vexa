/**
 * stt.v1 low-confidence filter golden — pins isLowConfidenceSegment, the single
 * chokepoint that drops acoustically-junk faster-whisper segments before they reach
 * the confirm loop. Pure + offline (the HTTP client is exercised by pipeline replay
 * + live L4). Run: npm test  (or npx tsx src/confidence.test.ts)
 */
import { isForeignScript, isLowConfidenceSegment } from "./index.js";

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failed++;
};

// Kept (real speech)
check("clean segment kept", isLowConfidenceSegment({ avg_logprob: -0.3, no_speech_prob: 0.1, compression_ratio: 1.5 }) === false);
check("empty segment kept (nothing to score)", isLowConfidenceSegment({}) === false);
check("high no_speech alone kept (logprob ok)", isLowConfidenceSegment({ avg_logprob: -0.5, no_speech_prob: 0.9 }) === false);

// Dropped (junk) — the three independent rules
check("high no_speech + low logprob dropped", isLowConfidenceSegment({ avg_logprob: -1.1, no_speech_prob: 0.7 }) === true);
check("high compression ratio dropped", isLowConfidenceSegment({ compression_ratio: 2.5 }) === true);
check("very low logprob dropped", isLowConfidenceSegment({ avg_logprob: -1.4 }) === true);

// Boundaries (strict comparisons — the threshold itself is kept)
check("logprob boundary -1.3 kept (strict <)", isLowConfidenceSegment({ avg_logprob: -1.3 }) === false);
check("compression boundary 2.4 kept (strict >)", isLowConfidenceSegment({ compression_ratio: 2.4 }) === false);

if (failed) { console.error(`\n❌ confidence: ${failed} checks FAILED.`); process.exit(1); }
console.log(`\n✅ confidence: all checks pass — junk segments dropped, real speech and threshold edges kept.`);


// ── the foreign-script gate (meeting 90: a noisy car, tr forced) ───────────────────────────────
{
  const real = [
    'Arabada çok gürültü olduğu için.',
    'Sen konuşmazsan saçmalıyor.',
    "Ama şöyle, İngilizce'de daha çok materyal...",
  ];
  const hallucinated = ['삶을 바라보는', '在家里', 'Солтүстік-шығысқа қараймын.', 'هادا.', 'あ', '또한,'];
  for (const text of real) {
    check(`real Turkish survives: ${text.slice(0, 28)}`, !isForeignScript(text, 'tr'));
  }
  for (const text of hallucinated) {
    check(`foreign-script hallucination dropped: ${text}`, isForeignScript(text, 'tr'));
  }
  check('a Latin-script hallucination is NOT caught here (the logprob gate owns it)',
    !isForeignScript('Hämähäkkä.', 'tr') && !isForeignScript('Jeg starter tirsdag.', 'tr'));
  check('one quoted foreign word inside a Turkish line survives',
    !isForeignScript('Japonca 猫 kelimesini kullandı.', 'tr'));
  check('without a forced language nothing is filtered', !isForeignScript('삶을 바라보는', undefined));
  check('a non-Latin deployment is never filtered by this gate',
    !isForeignScript('삶을 바라보는', 'ko') && !isForeignScript('Солтүстік', 'ru'));
}
