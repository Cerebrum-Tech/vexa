export interface NumberSignal {
  text: string;
  value?: number;
  context?: string;
  at?: number;
  end?: number;
}

const DOMAIN_CORRECTIONS: [RegExp, string][] = [
  [/\bDeep\s+Sea\b/gi, "DeepSeek"],
  [/\bDeep\s+Seek\b/gi, "DeepSeek"],
  [/\bDeepMIND\b/g, "DeepMind"],
  [/\bCloud\s+Code\b/gi, "Claude Code"],
  [/\bOpen\s+Router\b/gi, "OpenRouter"],
  [/\bEntropic\b/gi, "Anthropic"],
  [/\bAnthropoc\b/gi, "Anthropic"],
  [/\bUniversity\s+Chicago\b/gi, "University of Chicago"],
  [/\bYalna\s+Kunz\b/gi, "Yann LeCun"],
  [/\bYann\s+Le\s+Cun\b/gi, "Yann LeCun"],
];

const ORG_CONTRACTION_RE = /\b(China|Google|OpenAI|DeepMind|DeepSeek|Anthropic|Microsoft|Meta|Nvidia|Apple|Amazon)'s\s+([a-z]+ing)\b/gi;

const MONEY_RE = /[$€£]\s*\d[\d,]*(?:\.\d+)?\s*(?:billion|million|thousand|bn|mm|[kmb])?\+?/gi;
const QUARTER_RE = /\bQ[1-4](?:\s*(?:FY)?\d{2,4})?\b/gi;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const METRIC_RE = /\b\d[\d,]*(?:\.\d+)?\s*(?:%|billion|million|thousand|bn|mm|[kmb]\b|x\b|users?|seats?|licenses?|customers?|employees?|companies?|teams?|repos?|issues?|tickets?|ms|mb|gb|tb)(?=$|[\s,.;:!?)])/gi;

export function cleanTranscriptText(text: string): string {
  let out = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  out = out.replace(/([$€£]?\s*\d[\d,]*(?:\.\d+)?\s+)([bBmM])\s+illion\b/g, (_m, amount: string, unit: string) => {
    const suffix = unit.toLowerCase() === "b" ? "billion" : "million";
    return `${amount}${suffix}`;
  });
  for (const [pattern, replacement] of DOMAIN_CORRECTIONS) out = out.replace(pattern, replacement);
  out = out.replace(ORG_CONTRACTION_RE, "$1 is $2");
  return out.replace(/\s+([,.!?;:])/g, "$1").replace(/([^\d])([.!?])(?=\S)/g, "$1$2 ");
}

const TR_REPORTS = "(?:söylüyor|belirtiyor|ifade ediyor|dile getiriyor|aktarıyor|anlatıyor|açıklıyor|vurguluyor|not ediyor|bildiriyor|duyuruyor|paylaşıyor|diyor)";

/** Whitespace is already collapsed by cleanTranscriptText, so a literal space is enough here. */
function trRewrite(body: string, replacement: string): [RegExp, string] {
  return [new RegExp(`^Konuşmacı${body}`, "i"), replacement];
}

/** Observer boilerplate the assistant is told not to write, undone defensively at render time.
 *  Both language sets turn a reported frame into the first person the note should have carried, so
 *  a note stays in the speaker's own language whichever one they spoke. */
const SPEAKER_NOTE_REWRITES: [RegExp, string][] = [
  trRewrite(` (.+?) kullandığını ve (.+?) (?:beğendiğini|çekici bulduğunu) ${TR_REPORTS}\\.?$`, "$1 kullanıyorum ve $2 beğeniyorum."),
  trRewrite(` (.+?) kullandığını ve (.+?) hoşuna gittiğini ${TR_REPORTS}\\.?$`, "$1 kullanıyorum ve $2 hoşuma gidiyor."),
  trRewrite(` (.+?) (?:hakkında|konusunda) daha (?:fazlasını|fazla) (?:okuduğunu|okumuş olduğunu) ${TR_REPORTS}\\.?$`, "$1 hakkında daha fazlasını okudum."),
  trRewrite(` (.+?) (?:endişesini|korkusunu|kaygısını) (?:dile getiriyor|paylaşıyor|belirtiyor|ifade ediyor)\\.?$`, "Endişem şu ki $1."),
  trRewrite(` (?:başlangıçta|ilk başta|önce) (.+?) diye (?:düşündüğünü|sandığını) ${TR_REPORTS}\\.?$`, "Başlangıçta $1 diye düşünmüştüm."),
  trRewrite(` (?:başlangıçta|ilk başta|önce) (.+?) (?:düşündüğünü|sandığını) ${TR_REPORTS}\\.?$`, "Başlangıçta $1 düşünmüştüm."),
  trRewrite(` (.+?)acağını ${TR_REPORTS}\\.?$`, "$1acağım."),
  trRewrite(` (.+?)eceğini ${TR_REPORTS}\\.?$`, "$1eceğim."),
  trRewrite(` (.+?) (?:istediğini ${TR_REPORTS}|istiyor)\\.?$`, "$1 istiyorum."),
  trRewrite(`(?:nın)? (.+?) (?:ihtiyaç duyduğunu ${TR_REPORTS}|ihtiyaç duyuyor|ihtiyacı (?:olduğunu ${TR_REPORTS}|var))\\.?$`, "$1 ihtiyacım var."),
  trRewrite(` (.+?) (?:planladığını ${TR_REPORTS}|planlıyor)\\.?$`, "$1 planlıyorum."),
  trRewrite(` (.+?) (?:sorduğunu ${TR_REPORTS}|soruyor)\\.?$`, "$1 soruyorum."),
  trRewrite(` (.+?) (?:olduğunu|olduğuna) (?:düşünüyor|inanıyor|savunuyor|${TR_REPORTS})\\.?$`, "$1."),
  trRewrite(` (\\S+)'(?:nın|nin|nun|nün|ın|in|un|ün) (.+?)([dt][ıiuü])(?:ğını|ğini|ğunu|ğünü) ${TR_REPORTS}\\.?$`, "$1 $2$3."),
  trRewrite(` (.+?)([dt][ıiuü])(?:ğını|ğini|ğunu|ğünü) ${TR_REPORTS}\\.?$`, "$1$2."),
  trRewrite(` (.+?)([dt][ıu])klarını ${TR_REPORTS}\\.?$`, "$1$2lar."),
  trRewrite(` (.+?)([dt][iü])klerini ${TR_REPORTS}\\.?$`, "$1$2ler."),
  trRewrite(` (?:diyor ki|şunu söylüyor|şunları söylüyor) ?[:,]? ?`, ""),
  trRewrite(`:? `, ""),
  [/^Speaker\s+mentions\s+using\s+(.+?)\s+and\s+finding\s+(.+?)\s+appealing\.?$/i, "I use $1 and find $2 appealing."],
  [/^Speaker\s+(?:describes|frames)\s+(.+?)\s+as\s+/i, "$1 is "],
  [/^Speaker\s+read\s+more\s+about\s+/i, "I read more about "],
  [/^Speaker\s+(?:expresses|has)\s+fear\s+that\s+/i, "I'm afraid "],
  [/^Speaker\s+(?:initially\s+)?thought\s+/i, "I initially thought "],
  [/^Speaker\s+(?:believes|thinks)\s+(?:that\s+)?/i, ""],
  [/^Speaker\s+(?:announces|states|says|notes|reports|explains|emphasizes)\s+(?:that\s+)?/i, ""],
  [/^Speaker\s+will\s+/i, "I will "],
  [/^Speaker\s+wants\s+/i, "I want "],
  [/^Speaker\s+needs\s+/i, "I need "],
  [/^Speaker\s+plans\s+to\s+/i, "I plan to "],
  [/^Speaker\s+asks\s+/i, "I ask "],
  [/^Speaker\s+/i, ""],
];

export function cleanProcessedNoteText(text: string): string {
  let out = cleanTranscriptText(text);
  for (const [pattern, replacement] of SPEAKER_NOTE_REWRITES) {
    const next = out.replace(pattern, replacement).trim();
    if (next !== out) {
      out = next;
      break;
    }
  }
  return out.replace(/^[a-z]/, (ch) => ch.toUpperCase());
}

function valueOf(label: string): number | undefined {
  const cleaned = label.replace(/[^0-9.-]/g, "");
  const value = cleaned ? Number(cleaned) : undefined;
  return Number.isFinite(value) ? value : undefined;
}

function contextFor(label: string): string {
  const lower = label.toLowerCase();
  if (/[$€£]/.test(label)) return "Para";
  if (/%/.test(label)) return "Oran";
  if (/^q[1-4]/i.test(label)) return "Çeyrek";
  if (/^(?:19|20)\d{2}$/.test(label)) return "Yıl";
  if (/seats?|licenses?|users?|customers?/.test(lower)) return "Koltuk";
  if (/ms|mb|gb|tb/.test(lower)) return "Teknik";
  if (/billion|million|thousand|\bbn\b|\bmm\b|\b[kmb]\b|employees?|companies?|teams?|repos?|issues?|tickets?/.test(lower)) return "Ölçek";
  if (/\bx\b/.test(lower)) return "Kat";
  return "Sayı";
}

function addSignal(acc: NumberSignal[], seen: Set<string>, text: string, at: number): void {
  const label = text.replace(/[\s,.]+$/, "").trim();
  if (!label) return;
  const key = label.toLowerCase();
  if (seen.has(key)) return;
  if (acc.some((item) => item.at != null && item.end != null && at < item.end && at + label.length > item.at)) return;
  seen.add(key);
  acc.push({ text: label, value: valueOf(label), context: contextFor(label), at, end: at + label.length });
}

export function extractNotableNumberSpans(text: string): NumberSignal[] {
  const clean = cleanTranscriptText(text);
  const out: NumberSignal[] = [];
  const seen = new Set<string>();
  for (const re of [MONEY_RE, QUARTER_RE, YEAR_RE, METRIC_RE]) {
    re.lastIndex = 0;
    for (const match of clean.matchAll(re)) addSignal(out, seen, match[0], match.index ?? 0);
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

export function extractNotableNumbers(texts: string[], limit = 24): NumberSignal[] {
  const out: NumberSignal[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const signal of extractNotableNumberSpans(text)) {
      const key = signal.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: signal.text, value: signal.value, context: signal.context });
    }
  }
  return out.slice(-limit);
}
