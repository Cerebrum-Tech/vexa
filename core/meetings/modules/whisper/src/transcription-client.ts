import { log } from './log.js';
import { isForeignScript, isLowConfidenceSegment } from './confidence.js';
import { cleanSubtitleCredits, stripSubtitleCredit } from './subtitle-credit.js';

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  words?: TranscriptionWord[];
}

export interface TranscriptionResult {
  text: string;
  language: string;
  language_probability?: number;
  duration: number;
  segments: TranscriptionSegment[];
}

/** The response shape a model family can actually produce.
 *
 *  `verbose_json` (segments + word times) is Whisper's — every local faster-whisper unit and OpenAI's
 *  `whisper-1`. OpenAI's `gpt-4o-transcribe` family refuses it ("use json or text"); the `-diarize`
 *  variant is the one member that returns timed `segments` again, under `diarized_json`. The rest of
 *  the pipeline never sees the difference: a `json`-only reply becomes ONE segment spanning the
 *  submitted window, so the shared buffer still gets an end time to advance its offset to. */
export type SttResponseFormat = 'verbose_json' | 'diarized_json' | 'json';

export function sttResponseFormatFor(model: string): SttResponseFormat {
  const id = (model || '').toLowerCase();
  if (/diariz/.test(id)) return 'diarized_json';
  if (/transcribe/.test(id) && !/whisper/.test(id)) return 'json';
  return 'verbose_json';
}

export interface TranscriptionClientConfig {
  /** Base URL of transcription-service, e.g. "http://localhost:8083" */
  serviceUrl: string;
  /** Optional bearer token for authentication */
  apiToken?: string;
  /** Max retry attempts for transient failures. Default: 3 */
  maxRetries?: number;
  /** Base delay between retries in ms. Default: 1000 */
  retryDelayMs?: number;
  /** Per-request timeout in ms. Default: 30000 */
  requestTimeoutMs?: number;
  /** Sample rate of input audio. Default: 16000 */
  sampleRate?: number;
  /** Max speech segment duration in seconds. Whisper forces a segment split at this length.
   *  Lower values = more frequent confirmations = faster output. Default: server default (15s) */
  maxSpeechDurationSec?: number;
  /** Minimum silence duration (ms) for VAD to split segments. Lower = more splits at natural pauses.
   *  Default: server default (160ms). Use ~100ms for more granular segments. */
  minSilenceDurationMs?: number;
  /** STT model id sent as the OpenAI-compatible `model` form part. Backends that validate it
   *  (Groq, vLLM, gateways) need their served name; the bundled unit ignores it (its model is
   *  the unit's own MODEL_SIZE). Default: "whisper-1". */
  model?: string;
}

/** The STT boundary's FAILURE vocabulary (P5 + P18: an adapter must translate the
 *  dependency's failures, not just its successes). A consumer reads `.kind` to surface
 *  an attributable health event instead of silently degrading to "no transcript". */
export type TranscriptionFaultKind =
  | 'payment_required'   // 402 — out of balance / credits exhausted
  | 'unauthorized'       // 401 / 403 — bad or expired token
  | 'rate_limited'       // 429
  | 'unavailable'        // 5xx or network error
  | 'timeout'            // request aborted (no response in time)
  | 'bad_request'        // other 4xx
  | 'unknown';

/** A typed STT failure. `source` lets a consumer attribute it; `retryable` drives backoff. */
export class TranscriptionError extends Error {
  readonly source = 'stt' as const;
  constructor(
    readonly kind: TranscriptionFaultKind,
    readonly status: number | undefined,
    readonly detail: string | undefined,
    readonly retryable: boolean,
  ) {
    super(`stt ${kind}${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'TranscriptionError';
  }
}

/** Map an HTTP status to a typed fault (the anti-corruption translation, P5). */
function classifyHttp(status: number, detail?: string): TranscriptionError {
  if (status === 402) return new TranscriptionError('payment_required', status, detail, false);
  if (status === 401 || status === 403) return new TranscriptionError('unauthorized', status, detail, false);
  if (status === 429) return new TranscriptionError('rate_limited', status, detail, true);
  if (status >= 500) return new TranscriptionError('unavailable', status, detail, true);
  if (status >= 400) return new TranscriptionError('bad_request', status, detail, false);
  return new TranscriptionError('unknown', status, detail, false);
}

/**
 * HTTP client for the transcription-service.
 * Converts Float32Array audio to WAV, sends as multipart form,
 * and returns transcription results.
 */
export class TranscriptionClient {
  private serviceUrl: string;
  private apiToken: string | undefined;
  private maxRetries: number;
  private retryDelayMs: number;
  private requestTimeoutMs: number;
  private sampleRate: number;
  private maxSpeechDurationSec: number | undefined;
  private minSilenceDurationMs: number | undefined;
  private model: string;
  constructor(config: TranscriptionClientConfig) {
    // Ensure serviceUrl ends with the transcriptions endpoint
    this.serviceUrl = config.serviceUrl.replace(/\/+$/, '');
    if (!this.serviceUrl.endsWith('/v1/audio/transcriptions')) {
      this.serviceUrl += '/v1/audio/transcriptions';
    }
    this.apiToken = config.apiToken;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
    this.sampleRate = config.sampleRate ?? 16000;
    this.maxSpeechDurationSec = config.maxSpeechDurationSec;
    this.minSilenceDurationMs = config.minSilenceDurationMs;
    this.model = config.model ?? 'whisper-1';
  }

  /**
   * Transcribe a Float32Array audio buffer.
   * Converts to WAV, POSTs to transcription-service, returns parsed result.
   * Retries on transient failures (503, network errors).
   */
  async transcribe(audioData: Float32Array, language?: string, prompt?: string): Promise<TranscriptionResult> {
    const wavBuffer = this.float32ToWav(audioData);
    const windowSeconds = audioData.length / this.sampleRate;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.sendRequest(wavBuffer, language, prompt, windowSeconds);
        return result;
      } catch (err: any) {
        // Normalize anything non-HTTP (abort/network) into a typed fault too, so the
        // thrown value is ALWAYS a TranscriptionError the consumer can attribute (P18).
        const fault: TranscriptionError = err instanceof TranscriptionError
          ? err
          : new TranscriptionError(err?.name === 'AbortError' ? 'timeout' : 'unavailable', undefined, err?.message, true);
        const isLastAttempt = attempt === this.maxRetries;

        if (fault.retryable && !isLastAttempt) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          log(`[TranscriptionClient] ${fault.kind} (attempt ${attempt + 1}/${this.maxRetries + 1}): ${fault.message}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Non-retryable (402/401/4xx) or retries exhausted → surface the typed fault.
        log(`[TranscriptionClient] transcription failed after ${attempt + 1} attempt(s): ${fault.message}`);
        throw fault;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('Transcription failed: exhausted retries');
  }

  /**
   * Send the WAV buffer to the transcription-service as multipart form data.
   */
  private async sendRequest(wavBuffer: Buffer, language?: string, prompt?: string, windowSeconds = 0): Promise<TranscriptionResult> {
    // Build multipart form data manually (no external dependency needed)
    const boundary = `----FormBoundary${Date.now().toString(36)}`;
    const responseFormat = sttResponseFormatFor(this.model);

    const parts: Buffer[] = [];

    // File part
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    ));
    parts.push(wavBuffer);
    parts.push(Buffer.from('\r\n'));

    // Model part (required by OpenAI-compatible API; validating backends reject unknown ids)
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${this.model}\r\n`
    ));

    // Response format part
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `${responseFormat}\r\n`
    ));

    // Language part (if specified)
    if (language) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${language}\r\n`
      ));
    }

    // Request word-level timestamps — a Whisper-only parameter; the gpt-4o-transcribe family
    // rejects any timestamp request outright.
    if (responseFormat === 'verbose_json') {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="timestamp_granularities"\r\n\r\n` +
        `word\r\n`
      ));
    }
    // The gpt-4o-transcribe family has no per-segment confidence, but it does return per-token
    // log-probabilities on request. Their mean stands in for Whisper's avg_logprob, so the same
    // low-confidence gate that drops Whisper's phantom segments drops this family's — measured:
    // real speech ≈ −0.01 per token, a hallucinated word on noise ≈ −4.7.
    if (responseFormat === 'json') {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="include[]"\r\n\r\n` +
        `logprobs\r\n`
      ));
    }

    // Max speech segment duration (controls how often Whisper splits segments)
    if (this.maxSpeechDurationSec !== undefined) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="max_speech_duration_s"\r\n\r\n` +
        `${this.maxSpeechDurationSec}\r\n`
      ));
    }

    // Min silence duration for VAD segment splitting (lower = more splits at natural pauses)
    if (this.minSilenceDurationMs !== undefined) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="min_silence_duration_ms"\r\n\r\n` +
        `${this.minSilenceDurationMs}\r\n`
      ));
    }

    // Prompt: previous confirmed text as context for streaming continuity — Whisper only. The
    // gpt-4o-transcribe family treats `prompt` as a style hint and, on a window with no clear speech
    // (the pause between two phrases), returns the prompt text itself as the transcription. Measured:
    // 2s of noise + a 748-char prompt ⇒ the prompt back verbatim, twice out of twice. In a live
    // meeting that echo is then "stable" across two windows, confirms, becomes the next prompt and
    // loops — a ~140-word block published three times over.
    if (prompt && responseFormat === 'verbose_json') {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `${prompt}\r\n`
      ));
    }

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(this.serviceUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error response');
        throw classifyHttp(response.status, errorText);   // typed fault (P5/P18), not a bare Error
      }

      const data = await response.json() as any;

      // A timestamp-free reply (gpt-4o-transcribe's `json`) carries text only. The pipeline's
      // contract is segments with times, so the whole submitted window becomes one segment: its end
      // is the window's end, which is exactly the boundary the shared buffer advances to once the
      // words are confirmed. Whisper-shaped replies pass through untouched.
      const tokenLogprobs: number[] = Array.isArray(data.logprobs)
        ? data.logprobs.map((t: any) => Number(t?.logprob)).filter((v: number) => Number.isFinite(v))
        : [];
      const avgLogprob = tokenLogprobs.length
        ? tokenLogprobs.reduce((sum, v) => sum + v, 0) / tokenLogprobs.length
        : undefined;
      const rawSegments: any[] = Array.isArray(data.segments) && data.segments.length
        ? data.segments
        : ((data.text || '').trim() && windowSeconds > 0
          ? [{ start: 0, end: windowSeconds, text: String(data.text), avg_logprob: avgLogprob }]
          : []);
      const allSegments = rawSegments.map((s: any) => ({
        start: s.start || 0,
        end: s.end || 0,
        text: s.text || '',
        avg_logprob: s.avg_logprob,
        no_speech_prob: s.no_speech_prob,
        compression_ratio: s.compression_ratio,
        words: s.words,
      }));
      // Drop low-confidence (hallucinated / faint-bleed) segments at the source and
      // rebuild the text from what survives, so phantoms never reach the pipeline.
      // Match credits against original adjacency; confidence pruning must not
      // turn separate phrases into a new match across a removed segment.
      const creditCleaned = cleanSubtitleCredits(allSegments);
      // A forced-language deployment cannot legitimately produce a whole segment in another script;
      // that is a hallucination on noise, and the model returns it with full confidence.
      const foreign = creditCleaned.filter((s: any) => isForeignScript(s.text, language));
      const segments = creditCleaned.filter(s => !isLowConfidenceSegment(s) && !isForeignScript(s.text, language));
      const lowConfidenceCount = allSegments.filter((s: any) => isLowConfidenceSegment(s)).length;
      const text = allSegments.length
        ? segments.map((s: any) => (s.text || '').trim()).filter(Boolean).join(' ')
        : stripSubtitleCredit(data.text || '');
      if (lowConfidenceCount) {
        log(`[STT] dropped ${lowConfidenceCount}/${allSegments.length} low-confidence segment(s)`);
      }
      if (foreign.length) {
        log(`[STT] dropped ${foreign.length} segment(s) written in a script "${language}" does not use`);
      }
      if (creditCleaned !== allSegments || (!allSegments.length && text !== (data.text || ''))) {
        log('[STT] removed Turkish subtitle-credit text');
      }
      return {
        text,
        language: data.language || language || 'unknown',
        language_probability: data.language_probability ?? 0,
        duration: data.duration || windowSeconds || 0,
        segments,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Convert Float32Array audio samples to a WAV file buffer.
   * Output: 16-bit PCM, mono, at this.sampleRate (default 16kHz).
   */
  private float32ToWav(samples: Float32Array): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = samples.length * bytesPerSample;
    const headerSize = 44;
    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);

    // fmt sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);              // Sub-chunk size
    buffer.writeUInt16LE(1, 20);               // PCM format
    buffer.writeUInt16LE(numChannels, 22);     // Mono
    buffer.writeUInt32LE(this.sampleRate, 24);  // Sample rate
    buffer.writeUInt32LE(this.sampleRate * numChannels * bytesPerSample, 28); // Byte rate
    buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // Block align
    buffer.writeUInt16LE(bitsPerSample, 34);   // Bits per sample

    // data sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Convert Float32 [-1, 1] to Int16
    let offset = headerSize;
    for (let i = 0; i < samples.length; i++) {
      let sample = samples[i];
      // Clamp to [-1, 1]
      sample = Math.max(-1, Math.min(1, sample));
      // Convert to 16-bit integer
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      buffer.writeInt16LE(Math.round(int16), offset);
      offset += 2;
    }

    return buffer;
  }
}
