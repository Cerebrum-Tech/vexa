import type { TranscriptionSegment } from '@vexa/transcribe-whisper';

export interface TeamsContestRow {
  csrc: number;
  sourceKey: string;
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  completed: boolean;
}

export interface TeamsContestSubmission {
  sourceKey: string;
  segments: TranscriptionSegment[];
  /** Pipeline-only retention clock; the detector deliberately ignores it. */
  observedAtMs?: number;
}

export interface TeamsRoutedSpan {
  csrc: number;
  startMs: number;
  endMs: number;
}

export interface TeamsWordContest {
  leftSegmentId: string;
  rightSegmentId: string;
  leftCsrc: number;
  rightCsrc: number;
  leftTokenStart: number;
  rightTokenStart: number;
  tokenLength: number;
  contestedText: string;
  sharedRoutedMs: number;
  medianWordDeltaMs: number;
}

/** Which of two contested rows is the bleed copy, and why. */
export interface TeamsContestResolution {
  loserSegmentId: string;
  keeperSegmentId: string;
  reason: 'fragment' | 'unnamed' | 'routing';
}

export interface TeamsContestResolveOptions {
  /** Share of a row's tokens the contested phrase must cover for the row to count as a fragment. Default 0.6. */
  minFragmentCoverage?: number;
  /** Routed-audio lead one lane needs over the other, inside the contested window, to win a near-identical pair. Default 250 ms. */
  minRoutedLeadMs?: number;
  leftNamed?: boolean;
  rightNamed?: boolean;
}

export interface TeamsContestConfig {
  minSharedRoutedMs?: number;
  minMatchedTokens?: number;
  minMatchedCharacters?: number;
  minSingleMatchedCharacters?: number;
  maxMedianWordDeltaMs?: number;
}

interface Token {
  raw: string;
  normalized: string;
  start: number;
  end: number;
}

interface WordInterval {
  startMs: number;
  endMs: number;
}

interface WordTrace {
  mapped: Map<number, WordInterval>;
}

const normalize = (value: unknown): string => String(value ?? '')
  .toLocaleLowerCase()
  .replace(/[’]/g, "'")
  .replace(/[^\p{L}\p{N}']/gu, '');

export function tokenizeTeamsContestText(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const normalized = normalize(raw);
    if (!normalized) continue;
    tokens.push({ raw, normalized, start: match.index, end: match.index + raw.length });
  }
  return tokens;
}

function longestCommonContiguous(left: Token[], right: Token[]): {
  leftStart: number;
  rightStart: number;
  length: number;
} {
  let best = { leftStart: 0, rightStart: 0, length: 0 };
  let previous = new Uint16Array(right.length + 1);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    const current = new Uint16Array(right.length + 1);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
      if (left[leftIndex].normalized !== right[rightIndex].normalized) continue;
      const length = previous[rightIndex] + 1;
      current[rightIndex + 1] = length;
      if (length > best.length) {
        best = { leftStart: leftIndex - length + 1, rightStart: rightIndex - length + 1, length };
      }
    }
    previous = current;
  }
  return best;
}

const median = (values: number[]): number => {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

/** A segment's words with times. A backend that returns no word times (OpenAI's gpt-4o-transcribe
 *  family) still gives the segment's own span, so its tokens are spread evenly across it: coarse,
 *  but the contest test only asks whether two lanes heard the same words at roughly the same time
 *  (median delta ≤ 1.5 s), and both lanes were fed the same window. */
export const flattenedWords = (segments: TranscriptionSegment[]): Array<{
  normalized: string;
  start: number;
  end: number;
}> => segments.flatMap((segment) => {
  if (segment.words?.length) {
    return segment.words
      .map((word) => ({ normalized: normalize(word.word), start: Number(word.start), end: Number(word.end) }))
      .filter((word) => word.normalized && Number.isFinite(word.start) && Number.isFinite(word.end));
  }
  const tokens = tokenizeTeamsContestText(segment.text ?? '');
  const start = Number(segment.start);
  const end = Number(segment.end);
  if (!tokens.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const step = (end - start) / tokens.length;
  return tokens.map((token, index) => ({ normalized: token.normalized, start: start + index * step, end: start + (index + 1) * step }));
});

function consensusWordTrace(row: TeamsContestRow, submissions: TeamsContestSubmission[]): WordTrace | null {
  const rowTokens = tokenizeTeamsContestText(row.text);
  const candidates: Array<Map<number, WordInterval>> = [];
  for (const submission of submissions) {
    const words = flattenedWords(submission.segments);
    if (!words.length) continue;
    const wordTokens: Token[] = words.map((word) => ({
      raw: word.normalized,
      normalized: word.normalized,
      start: 0,
      end: word.normalized.length,
    }));
    const match = longestCommonContiguous(rowTokens, wordTokens);
    const minimumTraceTokens = Math.min(3, rowTokens.length);
    if (match.leftStart !== 0 || match.length < Math.max(minimumTraceTokens, Math.ceil(rowTokens.length * 0.6))) {
      continue;
    }
    const baseMs = row.startMs - words[match.rightStart].start * 1000;
    const mapped = new Map<number, WordInterval>();
    for (let index = 0; index < match.length; index++) {
      const word = words[match.rightStart + index];
      mapped.set(index, { startMs: baseMs + word.start * 1000, endMs: baseMs + word.end * 1000 });
    }
    candidates.push(mapped);
  }
  if (!candidates.length) return null;
  const mapped = new Map<number, WordInterval>();
  for (let tokenIndex = 0; tokenIndex < rowTokens.length; tokenIndex++) {
    const starts = candidates.map((candidate) => candidate.get(tokenIndex)?.startMs)
      .filter((value): value is number => Number.isFinite(value));
    const ends = candidates.map((candidate) => candidate.get(tokenIndex)?.endMs)
      .filter((value): value is number => Number.isFinite(value));
    if (starts.length && ends.length) mapped.set(tokenIndex, { startMs: median(starts), endMs: median(ends) });
  }
  return { mapped };
}

function phraseInterval(trace: WordTrace, start: number, length: number): WordInterval | null {
  const words = Array.from({ length }, (_, index) => trace.mapped.get(start + index));
  if (words.some((word) => !word)) return null;
  return { startMs: words[0]!.startMs, endMs: words[words.length - 1]!.endMs };
}

function mergedIntervals(spans: TeamsRoutedSpan[], csrc: number): Array<{ start: number; end: number }> {
  const rows = spans.filter((span) => span.csrc === csrc)
    .map((span) => ({ start: span.startMs, end: span.endMs }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end >= span.start)
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (last && row.start <= last.end + 20) last.end = Math.max(last.end, row.end);
    else merged.push({ ...row });
  }
  return merged;
}

function sharedRoutedMs(
  spans: TeamsRoutedSpan[],
  leftCsrc: number,
  rightCsrc: number,
  floor: number,
  ceiling: number,
): number {
  const left = mergedIntervals(spans, leftCsrc);
  const right = mergedIntervals(spans, rightCsrc);
  let leftIndex = 0;
  let rightIndex = 0;
  let total = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    total += Math.max(0, Math.min(left[leftIndex].end, right[rightIndex].end, ceiling)
      - Math.max(left[leftIndex].start, right[rightIndex].start, floor));
    if (left[leftIndex].end < right[rightIndex].end) leftIndex++;
    else rightIndex++;
  }
  return total;
}

export function detectTeamsWordContest(
  left: TeamsContestRow,
  right: TeamsContestRow,
  submissions: TeamsContestSubmission[],
  spans: TeamsRoutedSpan[],
  options: TeamsContestConfig = {},
): TeamsWordContest | null {
  if (!left.completed || !right.completed || left.csrc === right.csrc) return null;
  const floor = Math.max(left.startMs, right.startMs);
  const ceiling = Math.min(left.endMs, right.endMs);
  if (!(ceiling > floor)) return null;
  const config = {
    minSharedRoutedMs: options.minSharedRoutedMs ?? 250,
    minMatchedTokens: options.minMatchedTokens ?? 2,
    minMatchedCharacters: options.minMatchedCharacters ?? 10,
    minSingleMatchedCharacters: options.minSingleMatchedCharacters ?? 6,
    maxMedianWordDeltaMs: options.maxMedianWordDeltaMs ?? 1500,
  };
  const routedMs = sharedRoutedMs(spans, left.csrc, right.csrc, floor, ceiling);
  if (routedMs < config.minSharedRoutedMs) return null;

  const leftTokens = tokenizeTeamsContestText(left.text);
  const rightTokens = tokenizeTeamsContestText(right.text);
  const match = longestCommonContiguous(leftTokens, rightTokens);
  const contestedText = match.length
    ? left.text.slice(leftTokens[match.leftStart].start, leftTokens[match.leftStart + match.length - 1].end)
    : '';
  const matchedCharacters = contestedText.replace(/\s+/g, '').length;
  const ordinaryMatch = match.length >= config.minMatchedTokens && matchedCharacters >= config.minMatchedCharacters;
  const exactSingleWord = match.length === 1 && leftTokens.length === 1 && rightTokens.length === 1
    && matchedCharacters >= config.minSingleMatchedCharacters;
  if (!ordinaryMatch && !exactSingleWord) return null;

  const leftTrace = consensusWordTrace(left, submissions.filter((row) => row.sourceKey === left.sourceKey));
  const rightTrace = consensusWordTrace(right, submissions.filter((row) => row.sourceKey === right.sourceKey));
  if (!leftTrace || !rightTrace) return null;
  const deltas: number[] = [];
  for (let index = 0; index < match.length; index++) {
    const leftWord = leftTrace.mapped.get(match.leftStart + index);
    const rightWord = rightTrace.mapped.get(match.rightStart + index);
    if (!leftWord || !rightWord) continue;
    deltas.push(Math.abs((leftWord.startMs + leftWord.endMs - rightWord.startMs - rightWord.endMs) / 2));
  }
  const medianWordDeltaMs = median(deltas);
  if (deltas.length < match.length || medianWordDeltaMs > config.maxMedianWordDeltaMs) return null;
  if (!phraseInterval(leftTrace, match.leftStart, match.length)
      || !phraseInterval(rightTrace, match.rightStart, match.length)) return null;

  return {
    leftSegmentId: left.segmentId,
    rightSegmentId: right.segmentId,
    leftCsrc: left.csrc,
    rightCsrc: right.csrc,
    leftTokenStart: match.leftStart,
    rightTokenStart: match.rightStart,
    tokenLength: match.length,
    contestedText,
    sharedRoutedMs: Math.round(routedMs),
    medianWordDeltaMs: Math.round(medianWordDeltaMs),
  };
}

function wrapTokenRange(text: string, tokenStart: number, tokenLength: number, csrc: number, rivalCsrc: number): string {
  const tokens = tokenizeTeamsContestText(text);
  if (!tokens[tokenStart] || !tokens[tokenStart + tokenLength - 1]) return text;
  const start = tokens[tokenStart].start;
  const end = tokens[tokenStart + tokenLength - 1].end;
  return `${text.slice(0, start)}⟦${text.slice(start, end)}⟧{CSRC ${csrc}↔CSRC ${rivalCsrc}}${text.slice(end)}`;
}

export function markTeamsWordContests(row: TeamsContestRow, contests: TeamsWordContest[]): string {
  const relevant = contests.filter((contest) => contest.leftSegmentId === row.segmentId
    || contest.rightSegmentId === row.segmentId);
  const ranges = relevant.map((contest) => contest.leftSegmentId === row.segmentId
    ? { start: contest.leftTokenStart, length: contest.tokenLength, rival: contest.rightCsrc }
    : { start: contest.rightTokenStart, length: contest.tokenLength, rival: contest.leftCsrc })
    .sort((left, right) => right.start - left.start || right.length - left.length);
  let text = row.text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (range.start + range.length > lastStart) continue;
    text = wrapTokenRange(text, range.start, range.length, row.csrc, range.rival);
    lastStart = range.start;
  }
  return text;
}

function routedMsFor(spans: TeamsRoutedSpan[], csrc: number, floor: number, ceiling: number): number {
  let total = 0;
  for (const interval of mergedIntervals(spans, csrc)) {
    total += Math.max(0, Math.min(interval.end, ceiling) - Math.max(interval.start, floor));
  }
  return total;
}

/** Decide the bleed copy of a detected contest.
 *
 *  Both lanes were handed the same mixed frame, so both transcribed the phrase; only one owner spoke
 *  it. Three kinds of evidence separate them, in order of strength:
 *  1. A row that is (almost) nothing but the contested phrase is the bleed — the speaker's own lane
 *     carries the phrase inside a longer, fluent utterance. (`fragment`)
 *  2. Between two near-identical rows, a lane the track namer could not attribute is the bleed: an
 *     unnamed lane is by construction a participant whose voice indicator never lit for it. (`unnamed`)
 *  3. Otherwise the lane that was routed audio for less of the contested window loses. (`routing`)
 *  A pair that none of these separates stays verbatim on both sides — abstaining costs one duplicate
 *  line; guessing costs a real sentence under the wrong name. */
export function resolveTeamsWordContest(
  left: TeamsContestRow,
  right: TeamsContestRow,
  contest: TeamsWordContest,
  spans: TeamsRoutedSpan[],
  options: TeamsContestResolveOptions = {},
): TeamsContestResolution | null {
  const minCoverage = options.minFragmentCoverage ?? 0.6;
  const minLeadMs = options.minRoutedLeadMs ?? 250;
  const leftTokens = tokenizeTeamsContestText(left.text).length;
  const rightTokens = tokenizeTeamsContestText(right.text).length;
  if (!leftTokens || !rightTokens || !contest.tokenLength) return null;
  const leftFragment = contest.tokenLength / leftTokens >= minCoverage;
  const rightFragment = contest.tokenLength / rightTokens >= minCoverage;
  const decide = (loser: TeamsContestRow, keeper: TeamsContestRow, reason: TeamsContestResolution['reason']) =>
    ({ loserSegmentId: loser.segmentId, keeperSegmentId: keeper.segmentId, reason });

  if (leftFragment !== rightFragment) return leftFragment ? decide(left, right, 'fragment') : decide(right, left, 'fragment');
  if (!leftFragment) return null; // both rows carry substantial own speech around the phrase — partial overlap, abstain

  const leftNamed = options.leftNamed ?? true;
  const rightNamed = options.rightNamed ?? true;
  if (leftNamed !== rightNamed) return leftNamed ? decide(right, left, 'unnamed') : decide(left, right, 'unnamed');

  const floor = Math.max(left.startMs, right.startMs);
  const ceiling = Math.min(left.endMs, right.endMs);
  const leftRouted = routedMsFor(spans, left.csrc, floor, ceiling);
  const rightRouted = routedMsFor(spans, right.csrc, floor, ceiling);
  if (Math.abs(leftRouted - rightRouted) < minLeadMs) return null;
  return leftRouted < rightRouted ? decide(left, right, 'routing') : decide(right, left, 'routing');
}

export interface TeamsTextEchoOptions {
  /** Largest silence between the two rows' spans (or between the fragment and where the phrase sits in the
   *  longer row) for them to be one utterance. Default 3000 ms — a lane opens on a CSRC edge with up to
   *  ~1.2 s of onset lookback and closes on a 1–3 s onset gap, so the same words land in two rows up to a
   *  few seconds apart. */
  maxGapMs?: number;
  /** Share of a row's tokens the shared phrase must cover for that row to be "nothing but the phrase". Default 0.6. */
  minFragmentCoverage?: number;
  leftNamed?: boolean;
  rightNamed?: boolean;
}

export interface TeamsTextEchoResolution {
  loserSegmentId: string;
  keeperSegmentId: string;
  reason: 'echo-fragment' | 'echo-identical';
}

/** Where a token range of a row sits in time when the backend gave no word times: spread evenly over the row. */
function tokenRangeSpan(row: TeamsContestRow, tokenCount: number, start: number, length: number): { startMs: number; endMs: number } {
  const per = (row.endMs - row.startMs) / Math.max(1, tokenCount);
  return { startMs: row.startMs + per * start, endMs: row.startMs + per * (start + length) };
}

const gapBetween = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number =>
  Math.max(a.startMs, b.startMs) - Math.min(a.endMs, b.endMs);

/** The same words under two lanes at the same moment are ONE utterance transcribed twice.
 *
 *  Every active CSRC lane is handed the same mixed frame, and a lane opens with an onset lookback, so a
 *  speaker's last words routinely land twice: once closing their own row, once opening the next lane's
 *  ("robot bakımından. Orada" under Birkan 0.9 s after it closed Murat's row — meeting 126, 7 of 200 rows).
 *  The word contest above needs word times the backend may not give, a timestamp overlap the rows may not
 *  have, and a routed-audio trace the lookback may not leave; on that meeting it missed every one of these.
 *  What it does not need is any of that: the Teams lane transcribes a SINGLE mixed stream, so two people
 *  can never produce identical text at one moment — unison speech is one garbled signal, not two clean
 *  copies. Text plus time is the whole evidence.
 *
 *  Two shapes, resolved; everything else abstains:
 *  1. `echo-fragment` — one row is (almost) nothing but a phrase the other row carries, and the phrase's
 *     place in the longer row is within `maxGapMs` of the fragment. The fragment loses.
 *  2. `echo-identical` — the very same words on both sides, three or more, within `maxGapMs`. An
 *     unnamed lane loses to a named one; otherwise the later row loses (same start: the right-hand,
 *     later-published one). Two words or fewer stay: "Sağ olun." is something two people genuinely
 *     trade at a meeting's end.
 *  Two rows that each add their own words around a shared phrase are a partial overlap and stay —
 *  both may be real speech (the word contest's abstention rule, kept). */
export function resolveTeamsTextEcho(
  left: TeamsContestRow,
  right: TeamsContestRow,
  options: TeamsTextEchoOptions = {},
): TeamsTextEchoResolution | null {
  if (!left.completed || !right.completed || left.csrc === right.csrc) return null;
  const maxGapMs = options.maxGapMs ?? 3000;
  if (gapBetween(left, right) > maxGapMs) return null;
  const leftTokens = tokenizeTeamsContestText(left.text);
  const rightTokens = tokenizeTeamsContestText(right.text);
  if (!leftTokens.length || !rightTokens.length) return null;
  const match = longestCommonContiguous(leftTokens, rightTokens);
  const matchedCharacters = leftTokens.slice(match.leftStart, match.leftStart + match.length)
    .reduce((total, token) => total + token.normalized.length, 0);
  if (match.length < 2 || matchedCharacters < 10) return null;
  const minCoverage = options.minFragmentCoverage ?? 0.6;
  const leftCoverage = match.length / leftTokens.length;
  const rightCoverage = match.length / rightTokens.length;
  const decide = (loser: TeamsContestRow, keeper: TeamsContestRow, reason: TeamsTextEchoResolution['reason']) =>
    ({ loserSegmentId: loser.segmentId, keeperSegmentId: keeper.segmentId, reason });

  // A fragment: a row that is (almost) nothing but the phrase, against a row that carries more than it —
  // either substantially more (the 0.6 rule the word contest uses) or, when the fragment is the phrase
  // ENTIRELY, any longer row at all ("Tamamdır. O halde..." against "Tamamdır. O halde biz").
  const leftIsFragment = leftCoverage >= minCoverage && (rightCoverage < minCoverage
    || (leftCoverage === 1 && rightTokens.length > leftTokens.length));
  const rightIsFragment = rightCoverage >= minCoverage && (leftCoverage < minCoverage
    || (rightCoverage === 1 && leftTokens.length > rightTokens.length));
  if (leftIsFragment !== rightIsFragment) {
    const fragment = leftIsFragment ? left : right;
    const whole = leftIsFragment ? right : left;
    const phrase = leftIsFragment
      ? tokenRangeSpan(right, rightTokens.length, match.rightStart, match.length)
      : tokenRangeSpan(left, leftTokens.length, match.leftStart, match.length);
    if (gapBetween(fragment, phrase) > maxGapMs) return null;
    return decide(fragment, whole, 'echo-fragment');
  }
  // Identical: the very same words on both sides, three or more. Two rows that each add their own words
  // around a shared phrase are a partial overlap and stay — both may be real speech.
  const identical = leftCoverage === 1 && rightCoverage === 1 && leftTokens.length === rightTokens.length;
  if (!identical || match.length < 3) return null;
  const leftNamed = options.leftNamed ?? true;
  const rightNamed = options.rightNamed ?? true;
  if (leftNamed !== rightNamed) return leftNamed ? decide(right, left, 'echo-identical') : decide(left, right, 'echo-identical');
  if (left.startMs !== right.startMs) {
    return left.startMs < right.startMs ? decide(right, left, 'echo-identical') : decide(left, right, 'echo-identical');
  }
  return decide(right, left, 'echo-identical');
}
