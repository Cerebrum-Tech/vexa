/**
 * teams-text-echo — the same words under two lanes at one moment are one utterance, heard twice.
 *
 * Every row below is a pair the Teams lane published on meeting 126 (6 named lanes, local
 * faster-whisper, 24 min) and the word contest left standing — 7 of 200 durable rows. The
 * negative controls are the shapes a meeting legitimately produces: a two-word goodbye two people
 * trade, and two long rows that merely share a phrase.
 *
 *   tsx src/teams-text-echo.test.ts
 */
import { resolveTeamsTextEcho, type TeamsContestRow } from './teams-contested-word-marker.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : `  — ${detail}`}`);
  if (!cond) failed++;
};
const row = (csrc: number, id: string, text: string, startMs: number, endMs: number): TeamsContestRow =>
  ({ csrc, sourceKey: `csrc-${csrc}:1`, segmentId: id, text, startMs, endMs, completed: true });
const loser = (r: ReturnType<typeof resolveTeamsTextEcho>): string => r ? `${r.loserSegmentId}:${r.reason}` : 'null';

// 126 @ 794–800 s: Murat's sentence end re-opens Birkan's lane (the phrase sits 2 tokens before the end of the long row).
const murat = row(1053, 'm', 'Ama bu geldi. Yani bir ödeme stratejisinde yardımcı olacak bir robot bakımından. Orada şöyle oluyor.', 921_000, 927_200);
const birkan = row(1266, 'b', 'robot bakımından. Orada', 926_100, 928_300);
check('a fragment that is the tail of the other lane\'s row loses (echo-fragment)',
  loser(resolveTeamsTextEcho(murat, birkan)) === 'b:echo-fragment', loser(resolveTeamsTextEcho(murat, birkan)));
check('…in either argument order', loser(resolveTeamsTextEcho(birkan, murat)) === 'b:echo-fragment');

// 126 @ 835–846 s: the fragment follows the long row after a 0.0 s gap.
const b2 = row(1266, 'b2', 'Öbür türlü mesela Derya o verileri zaten Excel\'e çekiyor ya SAP\'den çekiyor Excel\'e atıyor bir şeyler ekliyor manuel bir şeyi', 962_000, 973_000);
const m2 = row(1053, 'm2', 'manuel bir şeyi', 973_000, 974_100);
check('a fragment right after the long row loses', loser(resolveTeamsTextEcho(b2, m2)) === 'm2:echo-fragment');

// 126 @ 810–814 s: identical five-word rows 1.5 s apart, no timestamp overlap.
const i1 = row(1266, 'i1', 'İşte ne yapmak lazım Birkan?', 937_457, 939_777);
const i2 = row(1053, 'i2', 'İşte ne yapmak lazım Birkan?', 938_935, 940_795);
check('identical rows within the gap: the later one loses (echo-identical)', loser(resolveTeamsTextEcho(i1, i2)) === 'i2:echo-identical');

// 126 @ 940 s: identical start, one row a word longer — keep the longer.
const t1 = row(1479, 't1', 'Tamamdır. O halde biz', 940_000, 941_600);
const t2 = row(840, 't2', 'Tamamdır. O halde...', 940_000, 941_000);
check('same start, one row entirely inside the other: the shorter copy loses', loser(resolveTeamsTextEcho(t1, t2)) === 't2:echo-fragment', loser(resolveTeamsTextEcho(t1, t2)));

// The word contest's own abstention case: each row adds a word of its own around the shared phrase.
const p1 = row(201, 'p1', 'ask amazing amazing like really good', 0, 2_400);
const p2 = row(840, 'p2', 'amazing amazing like really good answer', 0, 2_400);
check('two rows that each add their own word around a shared phrase stay', resolveTeamsTextEcho(p1, p2) === null, loser(resolveTeamsTextEcho(p1, p2)));

// An unnamed lane is by construction the mic no indicator lit for: it loses to a named one even if earlier.
const u1 = row(414, 'u1', 'Bir soru olursa Büşra sana şey yaparız yine.', 1_442_800, 1_445_000);
const n1 = row(627, 'n1', 'Bir soru olursa Büşra sana şey yaparız yine.', 1_445_600, 1_447_000);
check('an unnamed lane\'s copy loses to the named lane\'s', loser(resolveTeamsTextEcho(u1, n1, { leftNamed: false, rightNamed: true })) === 'u1:echo-identical');

// ── negative controls ──
const g1 = row(840, 'g1', 'Sağ olun.', 1_451_500, 1_452_300);
const g2 = row(1905, 'g2', 'Sağ olun.', 1_451_500, 1_452_300);
check('a two-word goodbye under two lanes stays (people trade those)', resolveTeamsTextEcho(g1, g2) === null);
const l1 = row(1053, 'l1', 'Yani biz bu raporlamaları yaparken bu robotları çalıştırırken hangi data kaynağıyla besleniyoruz', 0, 8_000);
const l2 = row(627, 'l2', 'Şimdi bu robotları çalıştırırken bizim desteğimize de ihtiyaç olacak hani', 6_000, 12_000);
check('two substantial rows sharing a phrase in their middles stay', resolveTeamsTextEcho(l1, l2) === null);
const far = row(1266, 'far', 'robot bakımından. Orada', 940_000, 942_000);
check('a fragment 13 s away from where the phrase sits is a real repetition, not an echo', resolveTeamsTextEcho(murat, far) === null);
const same = row(1053, 'same', 'robot bakımından. Orada', 926_100, 928_300);
check('two rows of one lane are never an echo', resolveTeamsTextEcho(murat, same) === null);
const draft = { ...birkan, completed: false };
check('a draft is not judged', resolveTeamsTextEcho(murat, draft) === null);

if (failed) { console.error(`\n❌ teams-text-echo: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\n✅ teams-text-echo: one utterance heard under two lanes keeps exactly one row; a goodbye and a shared phrase are left alone.');
