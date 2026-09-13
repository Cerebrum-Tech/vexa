/** POST /api/stt[?prompt=…] — speech-to-text proxy for composer dictation.
 *
 *  Body: audio/wav (16 kHz mono PCM from ui-kit/micDictation). Forwards to the same
 *  transcription service the meeting pipeline uses (`TRANSCRIPTION_SERVICE_URL`,
 *  OpenAI-compatible /v1/audio/transcriptions — see @vexa/transcribe-whisper's
 *  TranscriptionClient for the canonical contract). `prompt` carries the already-
 *  confirmed text for context continuity (streaming re-submission, exactly like the
 *  meeting pipeline). Returns `{ text, words }` — word timestamps drive the client's
 *  LocalAgreement confirm/trim. The bearer token stays server-side.
 */
import { NextResponse } from "next/server";
import { resolveApiKey } from "../proxyAuth";
import { sttEndpoint } from "./endpoint";
import { lowConfidence, spreadWords, sttResponseFormatFor, wavSeconds } from "./words";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // ~13 min of 16 kHz WAV — far beyond any dictation window

interface UpstreamWord { word?: string; start?: number; end?: number }
interface UpstreamSegment { text?: string; words?: UpstreamWord[] }

export async function POST(req: Request): Promise<NextResponse> {
  // Auth gate: this forwards to the shared transcription service with a server-side
  // bearer token. Without a check it's an open, credentialed Whisper proxy (cost/abuse
  // vector) — require the same per-user key every other proxy route resolves.
  if (!(await resolveApiKey())) return NextResponse.json({ error: "Oturumunuz doğrulanamadı — yeniden giriş yapın." }, { status: 401 });

  const base = (process.env.TRANSCRIPTION_SERVICE_URL ?? "").replace(/\/+$/, "");
  if (!base) return NextResponse.json({ error: "Transkripsiyon yapılandırılmamış (TRANSCRIPTION_SERVICE_URL)." }, { status: 503 });
  const endpoint = sttEndpoint(base);

  const wav = await req.arrayBuffer();
  if (wav.byteLength < 100) return NextResponse.json({ error: "Kayıt boş." }, { status: 400 });
  if (wav.byteLength > MAX_BYTES) return NextResponse.json({ error: "Kayıt çok uzun." }, { status: 413 });

  const prompt = new URL(req.url).searchParams.get("prompt") ?? "";

  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
  // The deployment's STT model id (validating backends reject unknown ids) — same env the
  // meeting pipeline's invocation carries; unset → whisper-1.
  const model = process.env.TRANSCRIPTION_MODEL || "whisper-1";
  const responseFormat = sttResponseFormatFor(model);
  form.append("model", model);
  form.append("response_format", responseFormat);
  // Word times are a Whisper-only request; the gpt-4o-transcribe family rejects it.
  if (responseFormat === "verbose_json") form.append("timestamp_granularities", "word");
  // The family's only confidence signal — a low mean means noise the model narrated, not speech.
  if (responseFormat === "json") form.append("include[]", "logprobs");
  if (prompt) form.append("prompt", prompt.slice(0, 800));
  // The deployment's transcription language — the same key meeting-api forces on bot and
  // upload requests, so dictation is decoded in the language the meetings are. A short clip
  // is exactly where auto-detect guesses worst; unset → the service auto-detects.
  const language = (process.env.VEXA_TRANSCRIPTION_LANGUAGE ?? "").trim();
  if (language) form.append("language", language);

  const headers: Record<string, string> = {};
  const token = process.env.TRANSCRIPTION_SERVICE_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const r = await fetch(endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return NextResponse.json({ error: `Transkripsiyon tamamlanamadı (${r.status}).`, detail: detail.slice(0, 300) }, { status: 502 });
    }
    const data = (await r.json()) as { text?: string; segments?: UpstreamSegment[]; logprobs?: { logprob?: number }[] };
    const text = lowConfidence(data.logprobs) ? "" : (data.text ?? "").trim();
    const upstreamWords = (data.segments ?? []).flatMap((s) => s.words ?? [])
      .filter((w) => typeof w.word === "string")
      .map((w) => ({ word: w.word as string, start: w.start ?? 0, end: w.end ?? 0 }));
    // A text-only reply still has to drive the composer's confirm/trim loop: spread the words
    // over the window that was actually submitted (its length is in the WAV header).
    const words = upstreamWords.length ? upstreamWords : spreadWords(text, wavSeconds(wav));
    return NextResponse.json({ text, words });
  } catch (err) {
    const timeout = err instanceof Error && err.name === "TimeoutError";
    return NextResponse.json({ error: timeout ? "Transkripsiyon zaman aşımına uğradı." : "Transkripsiyon hizmetine ulaşılamadı." }, { status: 502 });
  }
}
