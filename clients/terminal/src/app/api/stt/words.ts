/** What the dictation proxy can ask an STT model for, and how it keeps its own `{ text, words }`
 *  contract when the model answers with text alone.
 *
 *  Whisper (every local unit, OpenAI's `whisper-1`) answers `verbose_json` with word times. OpenAI's
 *  `gpt-4o-transcribe` family refuses that format ("use json or text") and returns text only; the
 *  `-diarize` member returns timed segments under `diarized_json`, still without words. The
 *  composer's LocalAgreement loop needs word END times only to know how much audio a confirmed
 *  prefix consumed, so words spread evenly over the submitted window are enough: the agreement
 *  itself is on the word strings across two passes, not on the timings.
 *
 *  Same family rule as `@vexa/transcribe-whisper` (`sttResponseFormatFor`) and meeting-api's upload
 *  adapter (`stt_response_format`).
 */
export type SttResponseFormat = "verbose_json" | "diarized_json" | "json";

export function sttResponseFormatFor(model: string): SttResponseFormat {
  const id = (model ?? "").toLowerCase();
  if (/diariz/.test(id)) return "diarized_json";
  if (/transcribe/.test(id) && !/whisper/.test(id)) return "json";
  return "verbose_json";
}

export interface SttWordOut { word: string; start: number; end: number }

/** `text` as words with times spread evenly across `[0, seconds]`. Each word keeps the leading
 *  space Whisper's own word objects carry, so the composer's `joinWords` (a plain concatenation)
 *  reads back as normal prose. */
export function spreadWords(text: string, seconds: number): SttWordOut[] {
  const tokens = (text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !(seconds > 0)) return [];
  const step = seconds / tokens.length;
  return tokens.map((token, index) => ({
    word: `${index ? " " : ""}${token}`,
    start: +(index * step).toFixed(3),
    end: +((index + 1) * step).toFixed(3),
  }));
}

/** Seconds of 16-bit mono audio in a RIFF/WAVE buffer (0 when it is not one). */
export function wavSeconds(wav: ArrayBuffer): number {
  if (wav.byteLength < 44) return 0;
  const view = new DataView(wav);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== "RIFF") return 0;
  const rate = view.getUint32(24, true);
  const block = view.getUint16(32, true) || 2;
  return rate ? Math.max(0, (wav.byteLength - 44) / (rate * block)) : 0;
}

/** Same bar as `@vexa/transcribe-whisper`'s low-confidence gate (avg_logprob < −1.3): the mean token
 *  log-probability of a `json` reply. Measured on gpt-4o-transcribe — real speech ≈ −0.01 per token,
 *  a word narrated over noise ≈ −4.7. No logprobs at all means "unknown", never "junk". */
export const LOW_CONFIDENCE_LOGPROB = -1.3;

export function lowConfidence(logprobs: { logprob?: number }[] | undefined): boolean {
  const values = (logprobs ?? []).map((t) => t.logprob).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!values.length) return false;
  return values.reduce((sum, v) => sum + v, 0) / values.length < LOW_CONFIDENCE_LOGPROB;
}
