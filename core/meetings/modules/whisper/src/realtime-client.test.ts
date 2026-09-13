/**
 * RealtimeTranscriber — proven against a fake socket: the session it asks for, the bytes it sends,
 * the draft it keeps, and what a commit resolves to. No network.
 */
import { RealtimeTranscriber, realtimeUrlFor, isStreamingSttModel, to24kPcm16, type RealtimeSocket } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

class FakeSocket implements RealtimeSocket {
  sent: any[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  closed: { code?: number; reason?: string } | null = null;
  constructor(public url: string, public headers: Record<string, string>) {}
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; this.onclose?.({ code, reason }); }
  open() { this.readyState = 1; this.onopen?.({}); }
  serve(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

check('realtimeUrlFor turns the batch base URL into the transcription session URL',
  realtimeUrlFor('https://api.openai.com') === 'wss://api.openai.com/v1/realtime?intent=transcription'
    && realtimeUrlFor('http://stt.local:8080/v1') === 'ws://stt.local:8080/v1/realtime?intent=transcription',
  realtimeUrlFor('https://api.openai.com'));
check('only the live model streams', isStreamingSttModel('gpt-live-transcribe') && !isStreamingSttModel('gpt-transcribe')
  && !isStreamingSttModel('gpt-4o-transcribe') && !isStreamingSttModel('whisper-1') && !isStreamingSttModel(null));
{
  const pcm = new Float32Array(16000).fill(0.5);   // 1 s at 16 kHz
  const bytes = to24kPcm16(pcm);
  check('16 kHz float → 24 kHz PCM16: 1 s becomes 24000 samples of 2 bytes, full scale preserved',
    bytes.length === 48000 && bytes.readInt16LE(0) === 16384 && bytes.readInt16LE(bytes.length - 2) === 16384, `${bytes.length}`);
}

async function session(): Promise<void> {
  let sock: FakeSocket | null = null;
  const deltas: string[] = []; const completed: string[] = []; const errors: string[] = [];
  const t = new RealtimeTranscriber({
    url: 'wss://x/v1/realtime?intent=transcription', apiToken: 'sk-test', model: 'gpt-live-transcribe',
    languages: ['tr'], noiseReduction: 'far_field', commitTimeoutMs: 50,
    connect: (url, headers) => (sock = new FakeSocket(url, headers)),
    onDelta: (d) => deltas.push(d), onCompleted: (x) => completed.push(x), onError: (e) => errors.push(e.message),
  });
  t.open();
  check('the bearer token rides the socket headers, never the URL', sock!.headers.Authorization === 'Bearer sk-test' && !sock!.url.includes('sk-test'));
  t.feed(new Float32Array(1600).fill(0.1));   // 100 ms before the session is ready → queued
  sock!.open();
  const update = sock!.sent[0];
  check('session.update: transcription session, 24 kHz pcm, the model, the language, far-field, no server VAD',
    update.type === 'session.update' && update.session.type === 'transcription'
      && update.session.audio.input.format.rate === 24000 && update.session.audio.input.transcription.model === 'gpt-live-transcribe'
      && JSON.stringify(update.session.audio.input.transcription.languages) === '["tr"]'
      && update.session.audio.input.noise_reduction.type === 'far_field' && update.session.audio.input.turn_detection === null,
    JSON.stringify(update));
  check('audio fed before session.updated is held back (the server would reject it)', sock!.sent.length === 1);
  sock!.serve({ type: 'session.updated', session: {} });
  check('…and flushed in order once the session is ready, as 24 kHz base64', sock!.sent.length === 2 && sock!.sent[1].type === 'input_audio_buffer.append'
    && Buffer.from(sock!.sent[1].audio, 'base64').length === 2400 * 2, `${sock!.sent.length}`);
  t.feed(new Float32Array(3200).fill(0.1));
  check('later audio goes straight through', sock!.sent.length === 3 && Buffer.from(sock!.sent[2].audio, 'base64').length === 4800 * 2);
  check('fed audio is accounted in input-time ms', Math.round(t.fedAudioMs) === 300, `${t.fedAudioMs}`);
  sock!.serve({ type: 'conversation.item.input_audio_transcription.delta', delta: ' Ben' });
  sock!.serve({ type: 'conversation.item.input_audio_transcription.delta', delta: ' geldim.' });
  check('deltas accumulate into the pending draft and are surfaced one by one', t.pendingText === ' Ben geldim.' && deltas.length === 2, t.pendingText);
  const p = t.commit();
  check('commit sends input_audio_buffer.commit', sock!.sent[sock!.sent.length - 1].type === 'input_audio_buffer.commit');
  sock!.serve({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Ben geldim.', usage: { type: 'duration', seconds: 1 } });
  const text = await p;
  check('commit resolves with the server\'s canonical transcript and clears the draft', text === 'Ben geldim.' && t.pendingText === '' && completed[0] === 'Ben geldim.', text);
  const sentBefore = sock!.sent.length;
  const empty = await t.commit();
  check('a commit with no audio since the last one is not sent (the server refuses <100 ms) and resolves empty',
    empty === '' && sock!.sent.length === sentBefore, `${JSON.stringify(empty)} sent=${sock!.sent.length - sentBefore}`);
  t.feed(new Float32Array(3200).fill(0.1));
  sock!.serve({ type: 'conversation.item.input_audio_transcription.delta', delta: ' Sonra' });
  const p2 = t.commit();
  const text2 = await p2;   // no completed arrives → timeout → the draft
  check('a commit the server never answers resolves with the streamed draft after the timeout', text2 === ' Sonra' && t.pendingText === '', JSON.stringify(text2));
  sock!.serve({ type: 'error', error: { message: 'boom' } });
  check('a server error reaches onError', errors.length === 1 && errors[0].includes('boom'), JSON.stringify(errors));
  const sentAtClose = sock!.sent.length;
  t.close();
  t.feed(new Float32Array(160));
  check('close closes the socket with a normal code and later audio is dropped', sock!.closed?.code === 1000 && sock!.sent.length === sentAtClose, `${sock!.sent.length} vs ${sentAtClose}`);
}

async function openRetry(): Promise<void> {
  const sockets: FakeSocket[] = [];
  const t = new RealtimeTranscriber({
    url: 'wss://x/v1/realtime?intent=transcription', model: 'gpt-live-transcribe',
    connect: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); return s; },
  });
  t.open();
  t.feed(new Float32Array(1600).fill(0.1));
  sockets[0].onclose?.({ code: 1006, reason: 'non-101' });       // handshake never completed
  await new Promise((r) => setTimeout(r, 600));
  check('a session that fails to open is retried', sockets.length === 2, `${sockets.length} socket(s)`);
  sockets[1].open(); sockets[1].serve({ type: 'session.updated', session: {} });
  check('…and the audio queued during the failed attempt is delivered on the retried session',
    sockets[1].sent.some((m) => m.type === 'input_audio_buffer.append'), JSON.stringify(sockets[1].sent.map((m) => m.type)));
  t.close();
}

session().then(openRetry).then(() => {
  if (failed) { console.error(`\n❌ realtime-client: ${failed} checks FAILED.`); process.exit(1); }
  console.log('\n✅ realtime-client: session shape, queued audio, deltas, commit and faults behave as the engine expects.');
});
