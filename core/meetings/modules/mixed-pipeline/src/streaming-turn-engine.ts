/**
 * Streaming turn engine — the realtime counterpart of the GMeet-compatible window.
 *
 * One streaming transcriber per turn key. Audio goes straight through as it arrives; the model's
 * append-only deltas form the live draft (published pending, one row per turn that only grows);
 * a row is CUT — committed on the server, then published confirmed with the server's canonical
 * text — when the speaker pauses after a sentence end, when the caller's cadence tick finds the
 * draft quiet, or when the turn closes. There is no re-transcription and no agreement loop: the
 * words never move once heard, so there is nothing to confirm except where a row ends.
 */
import { isForeignScript } from '@vexa/transcribe-whisper';
import type { EngineConfirmed, EnginePending, TranscriptEngine } from './transcript-engine.js';

/** What the engine needs from a streaming transcriber — `RealtimeTranscriber` satisfies it. */
export interface StreamingTranscriber {
  open(): void;
  feed(pcm16k: Float32Array): void;
  /** Close the current item; resolves with its canonical text (or the draft on timeout). */
  commit(): Promise<string>;
  close(): void;
  readonly pendingText: string;
}

export interface StreamingTranscriberHandlers {
  onDelta: (delta: string) => void;
  onError: (error: Error) => void;
}

export interface StreamingTurnEngineOptions {
  createTranscriber: (sourceKey: string, handlers: StreamingTranscriberHandlers) => StreamingTranscriber;
  /** The deployment's forced language — gates foreign-script hallucinations exactly like the batch client. */
  language?: string;
  /** A draft that ends a sentence and has not grown for this long is cut. Deltas arrive in bursts
   *  ~0.6–1.0 s apart mid-sentence, so anything shorter cuts between words. Default 1200 ms. */
  quietMs?: number;
  /** A draft that has not grown for this long is cut even mid-sentence (a long pause). Default 2000 ms. */
  silenceCutMs?: number;
  /** Once a row holds this much audio, a sentence end is cut without waiting for a pause — a
   *  continuous speaker never pauses, and a reader needs written rows, not one 80-second draft.
   *  Default 6000 ms. */
  eagerCutAfterMs?: number;
  /** A row that reaches this much audio is cut at the next word boundary even without a sentence
   *  end. Default 15000 ms. */
  maxRowMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  logger?: (message: string) => void;
}

interface TurnState {
  name: string;
  transcriber: StreamingTranscriber;
  /** Timeline (ms) of the first audio fed since the last cut — the forming row's start. */
  draftStartMs?: number;
  /** Timeline (ms) of the end of the last audio fed. */
  lastAudioMs: number;
  /** Wall clock of the last delta; the quiet rule reads it. */
  lastDeltaAt: number;
  cutting: Promise<void> | null;
  seq: number;
  lastConfirmed: string;
  closed: boolean;
}

const SENTENCE_END = /[.!?…]["'”’)]*\s*$/;

export class StreamingTurnEngine implements TranscriptEngine {
  onSegmentConfirmed: EngineConfirmed | null = null;
  onSegmentPending: EnginePending | null = null;
  private readonly turns = new Map<string, TurnState>();
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly silenceCutMs: number;
  private readonly eagerCutAfterMs: number;
  private readonly maxRowMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: StreamingTurnEngineOptions) {
    this.now = options.now ?? Date.now;
    this.quietMs = options.quietMs ?? 1200;
    this.silenceCutMs = options.silenceCutMs ?? 2000;
    this.eagerCutAfterMs = options.eagerCutAfterMs ?? 6000;
    this.maxRowMs = options.maxRowMs ?? 15000;
    this.log = options.logger ?? (() => undefined);
  }

  addSpeaker(sourceKey: string, name: string): void {
    if (this.turns.has(sourceKey)) return;
    const state: TurnState = {
      name, lastAudioMs: 0, lastDeltaAt: 0, cutting: null, seq: 0, lastConfirmed: '', closed: false,
      transcriber: undefined as unknown as StreamingTranscriber,
    };
    state.transcriber = this.options.createTranscriber(sourceKey, {
      onDelta: () => this.onDelta(sourceKey, state),
      onError: (error) => { this.log(`[StreamingTurn] ${sourceKey}: ${error.message}`); this.options.onError?.(error); },
    });
    this.turns.set(sourceKey, state);
    state.transcriber.open();
  }

  feedAudio(sourceKey: string, pcm: Float32Array, atMs?: number): void {
    const state = this.turns.get(sourceKey);
    if (!state || state.closed || pcm.length === 0) return;
    const at = atMs ?? this.now();
    if (state.draftStartMs === undefined) state.draftStartMs = at;
    state.lastAudioMs = at + (pcm.length / 16_000) * 1000;
    state.transcriber.feed(pcm);
    this.maybeCut(sourceKey, state);
  }

  async flushSpeaker(sourceKey: string, _force = false, _trimAtMs?: number): Promise<void> {
    const state = this.turns.get(sourceKey);
    if (!state) return;
    await this.cut(sourceKey, state, 'flush');
  }

  removeSpeaker(sourceKey: string): void {
    const state = this.turns.get(sourceKey);
    if (!state) return;
    state.closed = true;
    state.transcriber.close();
    this.turns.delete(sourceKey);
  }

  removeAll(): void {
    for (const key of [...this.turns.keys()]) this.removeSpeaker(key);
  }

  getActiveSpeakers(): string[] { return [...this.turns.keys()]; }

  async requestTranscription(sourceKey: string, force = false): Promise<boolean> {
    const state = this.turns.get(sourceKey);
    if (!state || state.closed) return false;
    if (force) { await this.cut(sourceKey, state, 'forced'); return true; }
    return this.maybeCut(sourceKey, state);
  }

  getLastConfirmedText(sourceKey: string): string { return this.turns.get(sourceKey)?.lastConfirmed ?? ''; }

  /** Where a row ends. A pause after a sentence end is the natural cut; a long row is cut at its
   *  next sentence end without waiting for one (continuous speech never pauses); a very long row is
   *  cut at the next word boundary; a long silence cuts whatever is there. The server's committed
   *  text is canonical either way, so an early cut costs row shape, never words. */
  private maybeCut(sourceKey: string, state: TurnState): boolean {
    const draft = state.transcriber.pendingText.trim();
    if (!draft || state.cutting || !state.lastDeltaAt) return false;
    const quiet = this.now() - state.lastDeltaAt;
    const rowMs = state.lastAudioMs - (state.draftStartMs ?? state.lastAudioMs);
    const atSentenceEnd = SENTENCE_END.test(draft);
    let why: string | null = null;
    if (atSentenceEnd && quiet >= this.quietMs) why = 'sentence';
    else if (atSentenceEnd && rowMs >= this.eagerCutAfterMs) why = 'sentence-eager';
    else if (rowMs >= this.maxRowMs && quiet >= 250) why = 'max-row';
    else if (quiet >= this.silenceCutMs) why = 'silence';
    if (!why) return false;
    void this.cut(sourceKey, state, why);
    return true;
  }

  private onDelta(sourceKey: string, state: TurnState): void {
    if (state.closed) return;
    state.lastDeltaAt = this.now();
    const text = state.transcriber.pendingText.trim();
    if (!text) return;
    this.onSegmentPending?.(sourceKey, state.name, text, state.draftStartMs ?? state.lastAudioMs, this.options.language);
  }

  private cut(sourceKey: string, state: TurnState, why: string): Promise<void> {
    if (state.cutting) return state.cutting;
    const startMs = state.draftStartMs ?? state.lastAudioMs;
    const endMs = state.lastAudioMs;
    state.draftStartMs = undefined;
    const job = (async () => {
      let text = '';
      try {
        text = (await state.transcriber.commit()).trim();
      } catch (error) {
        this.options.onError?.(error);
      }
      state.lastDeltaAt = 0;
      if (text && isForeignScript(text, this.options.language)) {
        this.log(`[StreamingTurn] dropped a row written in a script "${this.options.language}" does not use`);
        text = '';
      }
      if (!text) {
        // Nothing to keep: clear a pending draft the consumer may still show.
        this.onSegmentPending?.(sourceKey, state.name, '', startMs, this.options.language);
        return;
      }
      const segmentId = `${sourceKey}:${state.seq++}`;
      state.lastConfirmed = text;
      this.log(`[StreamingTurn] ${sourceKey} cut (${why}) ${Math.round(endMs - startMs)}ms "${text.slice(0, 60)}"`);
      this.onSegmentConfirmed?.(sourceKey, state.name, text, startMs, Math.max(startMs, endMs), segmentId, this.options.language);
    })();
    state.cutting = job;
    void job.finally(() => { if (state.cutting === job) state.cutting = null; });
    return job;
  }
}
