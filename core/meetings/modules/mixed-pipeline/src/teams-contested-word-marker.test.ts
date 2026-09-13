import type { TranscriptionSegment } from '@vexa/transcribe-whisper';
import {
  detectTeamsWordContest,
  markTeamsWordContests,
  resolveTeamsWordContest,
  type TeamsContestRow,
  type TeamsContestSubmission,
  type TeamsRoutedSpan,
} from './teams-contested-word-marker.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};

const words = (text: string, first = 0, step = 0.4): TranscriptionSegment[] => [{
  text,
  start: first,
  end: first + text.split(/\s+/).length * step,
  words: text.split(/\s+/).map((word, index) => ({
    word,
    start: first + index * step,
    end: first + (index + 0.8) * step,
    probability: 0.99,
  })),
}];

const left: TeamsContestRow = {
  csrc: 201,
  sourceKey: 'csrc-201:1',
  segmentId: 'left',
  text: 'ask amazing amazing like really good',
  startMs: 1000,
  endMs: 5000,
  completed: true,
};
const right: TeamsContestRow = {
  csrc: 840,
  sourceKey: 'csrc-840:1',
  segmentId: 'right',
  text: 'Amazing amazing like really good answer',
  startMs: 1400,
  endMs: 5000,
  completed: true,
};
const submissions: TeamsContestSubmission[] = [
  { sourceKey: left.sourceKey, segments: words(left.text) },
  { sourceKey: right.sourceKey, segments: words(right.text) },
];
const spans: TeamsRoutedSpan[] = [
  { csrc: 201, startMs: 1000, endMs: 5000 },
  { csrc: 840, startMs: 1400, endMs: 5000 },
];

const contest = detectTeamsWordContest(left, right, submissions, spans);
check('shared routed PCM + near word times + same phrase produces one unresolved contest',
  contest?.contestedText === 'amazing amazing like really good', JSON.stringify(contest));
if (contest) {
  check('only the exact duplicated words are wrapped on the named row',
    markTeamsWordContests(left, [contest])
      === 'ask ⟦amazing amazing like really good⟧{CSRC 201↔CSRC 840}');
  check('the rival row carries the symmetric unresolved marker',
    markTeamsWordContests(right, [contest])
      === '⟦Amazing amazing like really good⟧{CSRC 840↔CSRC 201} answer');
}

check('same text without shared routed PCM is not a contest',
  detectTeamsWordContest(left, right, submissions, [spans[0]]) === null);

const distantRight = { ...right, text: 'one two three four five Amazing amazing like really good' };
const distantSubmissions = submissions.concat({ sourceKey: right.sourceKey, segments: words(distantRight.text) });
check('same text far apart in Whisper word time is not a contest',
  detectTeamsWordContest(left, distantRight, distantSubmissions, spans) === null);

// ── no word times (gpt-4o-transcribe): the segment span still carries the contest ──
{
  const timeless = (text: string, start: number, end: number): TranscriptionSegment[] => [{ text, start, end } as TranscriptionSegment];
  const contestNoWords = detectTeamsWordContest(left, right, [
    { sourceKey: left.sourceKey, segments: timeless(left.text, 0, 2.4) },
    { sourceKey: right.sourceKey, segments: timeless(right.text, 0, 2.4) },
  ], spans);
  check('a backend without word times still yields the contest from evenly spread segment tokens',
    contestNoWords?.contestedText === 'amazing amazing like really good', JSON.stringify(contestNoWords));
}

// ── settling a contest: which row is the bleed copy ────────────────────────────────────────────
if (contest) {
  check('near-identical rows with equal routing and both named stay unresolved (abstain)',
    resolveTeamsWordContest(left, right, contest, spans) === null);
  check('between near-identical rows the lane the namer could not attribute loses',
    resolveTeamsWordContest(left, right, contest, spans, { leftNamed: true, rightNamed: false })?.loserSegmentId === 'right'
      && resolveTeamsWordContest(left, right, contest, spans, { leftNamed: false, rightNamed: true })?.reason === 'unnamed');
  check('between near-identical named rows the lane routed audio for less of the window loses',
    resolveTeamsWordContest(left, right, contest, [spans[0], { csrc: 840, startMs: 1400, endMs: 2400 }])?.loserSegmentId === 'right'
      && resolveTeamsWordContest(left, right, contest, [spans[0], { csrc: 840, startMs: 1400, endMs: 2400 }])?.reason === 'routing');
}

// The measured production shape (meeting 83): one lane carries the sentence, the other a bare fragment of it.
const owner: TeamsContestRow = {
  csrc: 201, sourceKey: 'csrc-201:5', segmentId: 'owner', completed: true, startMs: 1000, endMs: 6000,
  text: 'Diye bir cümle söyledim. Bakalım burada üç tane adım var değil mi?',
};
const fragment: TeamsContestRow = {
  csrc: 414, sourceKey: 'csrc-414:4', segmentId: 'fragment', completed: true, startMs: 1000, endMs: 3000,
  text: 'diye bir cümle söyledim.',
};
const fragmentSubmissions: TeamsContestSubmission[] = [
  { sourceKey: owner.sourceKey, segments: words(owner.text) },
  { sourceKey: fragment.sourceKey, segments: words(fragment.text) },
];
const fragmentSpans: TeamsRoutedSpan[] = [
  { csrc: 201, startMs: 1000, endMs: 6000 },
  { csrc: 414, startMs: 1000, endMs: 3000 },
];
const fragmentContest = detectTeamsWordContest(owner, fragment, fragmentSubmissions, fragmentSpans);
check('a bare fragment of a rival lane\'s sentence is a contest',
  fragmentContest?.contestedText === 'Diye bir cümle söyledim', JSON.stringify(fragmentContest));
if (fragmentContest) {
  const resolution = resolveTeamsWordContest(owner, fragment, fragmentContest, fragmentSpans);
  check('the fragment loses regardless of argument order or routing',
    resolution?.loserSegmentId === 'fragment' && resolution.reason === 'fragment'
      && resolveTeamsWordContest(fragment, owner, fragmentContest, fragmentSpans)?.loserSegmentId === 'fragment');
}
const partialLeft: TeamsContestRow = { ...owner, segmentId: 'pl', text: 'Aynen tamam sizden dönüş bekliyoruz onun dışında bir şey var mı' };
const partialRight: TeamsContestRow = { ...fragment, segmentId: 'pr', text: 'bana döndü aynen tamam sizden dönüş bekliyoruz onu da yazalım şimdi' };
const partialContest = detectTeamsWordContest(partialLeft, partialRight, [
  { sourceKey: partialLeft.sourceKey, segments: words(partialLeft.text) },
  { sourceKey: partialRight.sourceKey, segments: words(partialRight.text) },
], fragmentSpans);
check('two rows that each carry their own speech around a shared phrase are left verbatim',
  partialContest !== null && resolveTeamsWordContest(partialLeft, partialRight, partialContest, fragmentSpans) === null,
  JSON.stringify(partialContest));

if (failed > 0) process.exit(1);
console.log('\n✅ Teams contested-word diagnostics stay exact; a decidable bleed side is named, an undecidable pair is left alone.');
