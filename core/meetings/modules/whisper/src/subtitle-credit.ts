import type { TranscriptionSegment, TranscriptionWord } from './transcription-client.js';

// This subtitle credit is false output even when Whisper assigns healthy confidence.
const CREDIT = /(?<![\p{L}\p{N}_])alt\s*yaz[ıiİ]\s*(?:çevirmeni\s*)?[:\-]?\s*m\s*\.?\s*k(?![\p{L}\p{N}_])(?:\s*\.)?(?:\s+taraf[ıiİ]ndan(?![\p{L}\p{N}_]))?/giu;
type Span = { start: number; end: number };
const compact = (text: string): string => text.replace(/\s+/g, '').normalize('NFC');

function spans(text: string): Span[] {
  return [...text.matchAll(CREDIT)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
}

function removeSpans(text: string, removed: Span[]): string {
  if (!removed.length) return text;
  let cleaned = text;
  for (const span of [...removed].reverse()) cleaned = cleaned.slice(0, span.start) + cleaned.slice(span.end);
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : '';
}

export function stripSubtitleCredit(text: string): string {
  return removeSpans(text, spans(text));
}

function retainedWords(segment: TranscriptionSegment, removed: Span[], cleaned: string): TranscriptionWord[] | undefined {
  const words = segment.words;
  if (!words || words.some(word => typeof word.word !== 'string')) return undefined;
  if (compact(words.map(word => word.word).join('')) !== compact(segment.text)) return undefined;
  const ranges = removed.map(span => ({ start: compact(segment.text.slice(0, span.start)).length,
    end: compact(segment.text.slice(0, span.end)).length }));
  const retained: TranscriptionWord[] = [];
  let offset = 0;
  for (const word of words) {
    const start = offset; offset += compact(word.word).length;
    const overlap = ranges.find(range => range.start < offset && range.end > start);
    if (!overlap) retained.push(word);
    // A token containing both speech and a credit cannot keep an accurate partial timestamp.
    else if (overlap.start > start || overlap.end < offset) return undefined;
  }
  return compact(retained.map(word => word.word).join('')) === compact(cleaned) ? retained : undefined;
}

/** Remove only the known credit, including when the provider splits it across segments. */
export function cleanSubtitleCredits(segments: TranscriptionSegment[]): TranscriptionSegment[] {
  const removed = spans(segments.map(segment => segment.text).join(' '));
  if (!removed.length) return segments;
  let offset = 0;
  return segments.flatMap(segment => {
    const start = offset; offset += segment.text.length + 1;
    const local = removed.filter(span => span.start < offset - 1 && span.end > start)
      .map(span => ({ start: Math.max(0, span.start - start), end: Math.min(segment.text.length, span.end - start) }));
    if (!local.length) return [segment];
    const text = removeSpans(segment.text, local);
    if (!text) return [];
    return [{ ...segment, text, words: retainedWords(segment, local, text) }];
  });
}
