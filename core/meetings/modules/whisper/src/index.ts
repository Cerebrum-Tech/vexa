/**
 * @vexa/transcribe-whisper — the shared stt.v1 egress.
 *
 * One concern: take a PCM window → call the hosted Whisper service → return
 * verbose segments, with the low-confidence/hallucination STT filter applied at
 * source. Both lanes (gmeet channel-router, mixed segmenter) drive the shared
 * buffer, which calls THIS via the injected `transcribe(pcm, prompt)` fn — so
 * whisper has no knowledge of topology, naming, or confirmation.
 */
export { TranscriptionClient, TranscriptionError, sttResponseFormatFor } from './transcription-client.js';
export type { SttResponseFormat } from './transcription-client.js';
export type {
  TranscriptionWord,
  TranscriptionSegment,
  TranscriptionResult,
  TranscriptionClientConfig,
  TranscriptionFaultKind,
} from './transcription-client.js';
export { isForeignScript, isLowConfidenceSegment } from './confidence.js';
export { RealtimeTranscriber, realtimeUrlFor, isStreamingSttModel, to24kPcm16 } from './realtime-client.js';
export type { RealtimeTranscriberConfig, RealtimeSocket } from './realtime-client.js';
export { setLogger } from './log.js';
