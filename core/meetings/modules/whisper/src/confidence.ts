/**
 * Low-confidence / hallucinated STT-segment filter — applied at the stt.v1 egress
 * (the shared transcription client), the single chokepoint for every lane. Drops
 * faster-whisper segments that are acoustically junk before they ever reach the
 * confirm loop. (The phrase-list hallucination filter is a separate, downstream
 * concern that lives with the buffer.)
 */
export function isLowConfidenceSegment(s: { avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number }): boolean {
  if (s.no_speech_prob !== undefined && s.avg_logprob !== undefined && s.no_speech_prob > 0.6 && s.avg_logprob < -1.0) return true;
  if (s.compression_ratio !== undefined && s.compression_ratio > 2.4) return true;
  if (s.avg_logprob !== undefined && s.avg_logprob < -1.3) return true;
  return false;
}

/** Scripts a Latin-script deployment's speech cannot be written in. A hallucination on noise is the
 *  only thing that produces a whole Hangul / CJK / Arabic / Cyrillic / Devanagari segment in a
 *  Turkish meeting — measured on meeting 90 (a noisy car), where a silent stretch produced
 *  "삶을 바라보는", "在家里", "Солтүстік-шығысқа қараймын" and "هادا" between real Turkish sentences. */
const FOREIGN_SCRIPT = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Greek}]/gu;
const LETTERS = /\p{L}/gu;

/** True when `text` is mostly written in a script the deployment's language does not use.
 *
 *  Only consulted when the operator FORCED a language (`VEXA_TRANSCRIPTION_LANGUAGE`) — without one,
 *  a multilingual room is legitimate and this must never fire. The bar is deliberately "most of the
 *  segment": a single quoted word stays, a whole invented line goes. */
export function isForeignScript(text: string, language?: string): boolean {
  if (!language || !LATIN_SCRIPT_LANGUAGES.has(language.toLowerCase().slice(0, 2))) return false;
  const letters = (text.match(LETTERS) ?? []).length;
  if (letters < 2) return false;
  const foreign = (text.match(FOREIGN_SCRIPT) ?? []).length;
  return foreign / letters > 0.5;
}

/** The languages this gate understands as Latin-script. Anything else disables it rather than
 *  guessing — a Russian or Japanese deployment must never have its own transcript filtered. */
const LATIN_SCRIPT_LANGUAGES = new Set([
  'tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl',
  'da', 'sv', 'no', 'nb', 'nn', 'fi', 'et', 'lv', 'lt', 'sq', 'az', 'id', 'ms', 'vi', 'af', 'cy', 'is',
]);
