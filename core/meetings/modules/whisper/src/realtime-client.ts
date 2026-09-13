/**
 * Streaming STT over OpenAI's Realtime transcription session (`gpt-live-transcribe`).
 *
 * One session per speaker turn: audio is pushed as it arrives (16 kHz float → 24 kHz PCM16, the
 * session's only accepted rate), the model streams word-level DELTAS as it hears them (measured
 * ~0.8 s behind the audio), and a client `commit` closes the current item and yields the canonical
 * `completed` transcript for it (~0.5 s). The model does no turn detection of its own — server VAD
 * is refused for it — so the CALLER decides where a row ends: a pause, a sentence end, the turn's
 * close. Deltas are append-only (a delta never revises earlier text), which is what makes the
 * forming text safe to show as a live draft without a confirmation loop.
 *
 * The socket is injected (`connect`) so the client is testable without a network; production uses
 * the Node global `WebSocket`. Nothing here knows about speakers or the pipeline.
 */
import { log } from './log.js';

/** The subset of the WebSocket surface this client uses — Node 22's global implements it. */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export interface RealtimeTranscriberConfig {
  /** `wss://…/v1/realtime?intent=transcription` — see `realtimeUrlFor`. */
  url: string;
  apiToken?: string;
  /** Transcription model id — `gpt-live-transcribe` (the streaming one) or a committed-turn model. */
  model: string;
  /** ISO 639-1 codes the audio may contain. A forced deployment passes exactly one. */
  languages?: string[];
  /** Recording context (style hint, NOT previous transcript — see the batch client's prompt rule). */
  prompt?: string;
  /** Vocabulary hints (names, product terms) the model should prefer. */
  keywords?: string[];
  /** `near_field` for a headset, `far_field` for a room mic or a re-encoded feed. */
  noiseReduction?: 'near_field' | 'far_field' | null;
  /** The model's latency/accuracy dial. Default `low`. */
  delay?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Socket factory (tests). Default: the global WebSocket with a bearer header. */
  connect?: (url: string, headers: Record<string, string>) => RealtimeSocket;
  /** How long `commit()` waits for the server's `completed` before resolving with the draft. */
  commitTimeoutMs?: number;
  onDelta?: (delta: string) => void;
  onCompleted?: (transcript: string, usage?: unknown) => void;
  onError?: (error: Error) => void;
  onClose?: (code?: number, reason?: string) => void;
}

/** The realtime session URL for an OpenAI-compatible base URL (`https://api.openai.com` → `wss://…`). */
export function realtimeUrlFor(serviceUrl: string): string {
  const u = new URL(serviceUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = '/v1/realtime';
  u.search = '?intent=transcription';
  u.hash = '';
  return u.toString();
}

/** True when the configured STT model is a streaming (realtime-only) model. */
export function isStreamingSttModel(model: string | null | undefined): boolean {
  return /live-transcribe/i.test(model ?? '');
}

/** 16 kHz float PCM → 24 kHz signed 16-bit little-endian, linear interpolation (speech-safe). */
export function to24kPcm16(pcm16k: Float32Array): Buffer {
  const ratio = 1.5;
  const n = Math.floor(pcm16k.length * ratio);
  const out = Buffer.alloc(n * 2);
  const last = pcm16k.length - 1;
  for (let i = 0; i < n; i++) {
    const x = i / ratio;
    const i0 = Math.min(Math.floor(x), last);
    const i1 = Math.min(i0 + 1, last);
    const v = pcm16k[i0] + (pcm16k[i1] - pcm16k[i0]) * (x - i0);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 2 * i);
  }
  return out;
}

const OPEN = 1;
const MAX_OPEN_ATTEMPTS = 3;
const OPEN_RETRY_MS = 500;

export class RealtimeTranscriber {
  private socket: RealtimeSocket | null = null;
  private ready = false;
  private closed = false;
  private readonly queued: Buffer[] = [];
  /** Text streamed since the last completed item — the forming draft. */
  private draft = '';
  private pendingCommit: { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Audio pushed so far, in ms of 16 kHz input — the session's own timeline. */
  private fedMs = 0;
  /** Audio pushed since the last commit — the server refuses to commit under 100 ms. */
  private fedSinceCommitMs = 0;
  private openAttempts = 0;

  constructor(private readonly cfg: RealtimeTranscriberConfig) {}

  /** Open the session. Audio fed before `session.updated` is queued and flushed in order. */
  open(): void {
    if (this.socket) return;
    const connect = this.cfg.connect ?? defaultConnect;
    const headers: Record<string, string> = {};
    if (this.cfg.apiToken) headers.Authorization = `Bearer ${this.cfg.apiToken}`;
    let socket: RealtimeSocket;
    try {
      socket = connect(this.cfg.url, headers);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.socket = socket;
    this.openAttempts++;
    socket.onopen = () => {
      const input: Record<string, unknown> = {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: {
          model: this.cfg.model,
          ...(this.cfg.languages?.length ? { languages: this.cfg.languages } : {}),
          ...(this.cfg.prompt ? { prompt: this.cfg.prompt } : {}),
          ...(this.cfg.keywords?.length ? { keywords: this.cfg.keywords } : {}),
          delay: this.cfg.delay ?? 'low',
        },
        // The streaming model refuses server turn detection; rows are cut by the caller's commits.
        turn_detection: null,
      };
      if (this.cfg.noiseReduction) input.noise_reduction = { type: this.cfg.noiseReduction };
      socket.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input } } }));
    };
    socket.onmessage = (ev) => this.handle(ev.data);
    socket.onerror = (ev) => {
      if (!this.ready && !this.closed && this.openAttempts < MAX_OPEN_ATTEMPTS) return;   // the close handler retries
      this.fail(new Error(`realtime socket error: ${describe(ev)}`));
    };
    socket.onclose = (ev) => {
      // A handshake that never completed is retried with the queued audio intact — a session
      // that fails to open must not cost the turn its words.
      if (!this.ready && !this.closed && this.openAttempts < MAX_OPEN_ATTEMPTS) {
        this.socket = null;
        log(`[STT] realtime session did not open (attempt ${this.openAttempts}) — retrying`);
        setTimeout(() => { if (!this.closed) this.open(); }, OPEN_RETRY_MS * this.openAttempts);
        return;
      }
      this.closed = true;
      this.ready = false;
      if (this.pendingCommit) {
        clearTimeout(this.pendingCommit.timer);
        const { resolve } = this.pendingCommit;
        this.pendingCommit = null;
        resolve(this.draft);
      }
      this.cfg.onClose?.(ev?.code, ev?.reason);
    };
  }

  /** Push 16 kHz float audio; becomes 24 kHz PCM16 on the wire. Safe before the session is ready. */
  feed(pcm16k: Float32Array): void {
    if (this.closed || pcm16k.length === 0) return;
    const ms = (pcm16k.length / 16_000) * 1000;
    this.fedMs += ms;
    this.fedSinceCommitMs += ms;
    const bytes = to24kPcm16(pcm16k);
    if (!this.ready || !this.socket || this.socket.readyState !== OPEN) {
      this.queued.push(bytes);
      return;
    }
    this.append(bytes);
  }

  /** Close the current item: the server answers with its canonical transcript (`completed`).
   *  Resolves with that text — or, if the server stays silent past the timeout or the socket is
   *  gone, with the streamed draft, which is the same words minus the server's final punctuation. */
  commit(): Promise<string> {
    if (this.pendingCommit) return Promise.resolve(this.draft);
    // Nothing new since the last commit: the server would answer with an error, not a transcript.
    if (this.fedSinceCommitMs < 100) {
      const text = this.draft;
      this.draft = '';
      return Promise.resolve(text);
    }
    if (this.closed || !this.socket || !this.ready || this.socket.readyState !== OPEN) {
      const text = this.draft;
      this.draft = '';
      return Promise.resolve(text);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingCommit) return;
        this.pendingCommit = null;
        const text = this.draft;
        this.draft = '';
        resolve(text);
      }, this.cfg.commitTimeoutMs ?? 2500);
      this.pendingCommit = { resolve, timer };
      this.fedSinceCommitMs = 0;
      this.socket!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    });
  }

  /** The forming (uncommitted) text so far. */
  get pendingText(): string { return this.draft; }
  /** Milliseconds of input audio pushed into this session. */
  get fedAudioMs(): number { return this.fedMs; }
  get isOpen(): boolean { return this.ready && !this.closed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    try { this.socket?.close(1000, 'turn closed'); } catch { /* already gone */ }
  }

  private append(bytes: Buffer): void {
    this.socket!.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') }));
  }

  private handle(raw: unknown): void {
    let event: any;
    try { event = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    switch (event?.type) {
      case 'session.updated':
        this.ready = true;
        for (const bytes of this.queued.splice(0)) this.append(bytes);
        return;
      case 'conversation.item.input_audio_transcription.delta': {
        const delta = String(event.delta ?? '');
        if (!delta) return;
        this.draft += delta;
        this.cfg.onDelta?.(delta);
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = String(event.transcript ?? '').trim();
        this.draft = '';
        if (this.pendingCommit) {
          clearTimeout(this.pendingCommit.timer);
          const { resolve } = this.pendingCommit;
          this.pendingCommit = null;
          resolve(transcript);
        }
        this.cfg.onCompleted?.(transcript, event.usage);
        return;
      }
      case 'error': {
        const message = event.error?.message ?? 'unknown realtime error';
        this.fail(new Error(`realtime: ${message}`));
        return;
      }
      default:
        return;
    }
  }

  private fail(error: Error): void {
    log(`[STT] realtime fault: ${error.message}`);
    this.cfg.onError?.(error);
  }
}

function defaultConnect(url: string, headers: Record<string, string>): RealtimeSocket {
  const Ctor = (globalThis as any).WebSocket;
  if (typeof Ctor !== 'function') throw new Error('realtime: no WebSocket implementation in this runtime');
  return new Ctor(url, { headers }) as RealtimeSocket;
}

function describe(ev: unknown): string {
  const e = ev as { message?: string; error?: { message?: string } } | null;
  return e?.message ?? e?.error?.message ?? 'socket error';
}
