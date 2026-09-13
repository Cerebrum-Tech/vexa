/**
 * The engine seam the Teams CSRC pipeline speaks to. Two implementations: the shared GMeet-compatible
 * window (batch STT, re-transcribe-and-confirm) and the streaming turn engine (realtime STT, deltas
 * as they arrive, rows cut at pauses). The pipeline owns speaker attribution, ownership, drafts and
 * publication either way; the engine only turns one turn key's audio into pending/confirmed text.
 */
export type EngineConfirmed = (
  sourceKey: string, name: string, text: string, startMs: number, endMs: number, segmentId: string, language?: string,
) => void;
export type EnginePending = (sourceKey: string, name: string, text: string, startMs: number, language?: string) => void;

export interface TranscriptEngine {
  addSpeaker(sourceKey: string, name: string): void;
  feedAudio(sourceKey: string, pcm: Float32Array, atMs?: number): void;
  flushSpeaker(sourceKey: string, force?: boolean, trimAtMs?: number): Promise<void>;
  removeSpeaker(sourceKey: string): void;
  removeAll(): void;
  getActiveSpeakers(): string[];
  /** Deterministic replay seam: run the engine's own cadence now. True when work was requested. */
  requestTranscription(sourceKey: string, force?: boolean): Promise<boolean>;
  getLastConfirmedText(sourceKey: string): string;
  onSegmentConfirmed: EngineConfirmed | null;
  onSegmentPending: EnginePending | null;
}
