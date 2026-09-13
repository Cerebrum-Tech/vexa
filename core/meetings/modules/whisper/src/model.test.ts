/**
 * P5 gate (the #522 fixture the STT seam lacked): the request the wire actually sees carries the
 * DEPLOYMENT'S model id — a validating OpenAI-compatible backend (Groq, vLLM, LiteLLM) rejects a
 * wrong `model` form part with 404 model_not_found, so the adapter must send the configured id and
 * default to `whisper-1` byte-for-byte when none is configured. Stubs global fetch and inspects
 * the multipart body ("validating backend" edge — D-A2).
 * Run: npm test (chained)  or  npx tsx src/model.test.ts
 */
import { TranscriptionClient, sttResponseFormatFor } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const realFetch = globalThis.fetch;
/** Replace global fetch with a 200 stub that CAPTURES the multipart body. */
function captureFetch(): () => string {
  let body = '';
  (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
    body = Buffer.from(init.body).toString('latin1');
    return new Response(JSON.stringify({ text: 'ok', language: 'en', duration: 0.1, segments: [] }), { status: 200 });
  };
  return () => body;
}
/** The value of the `model` form part in a captured multipart body (null if absent). */
function modelPartOf(body: string): string | null {
  const m = body.match(/name="model"\r\n\r\n([^\r]*)\r\n/);
  return m ? m[1] : null;
}

async function run() {
  const pcm = new Float32Array(1600).fill(0.05); // 0.1s of audio

  // Configured model → the wire carries exactly that id.
  {
    const body = captureFetch();
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'whisper-large-v3-turbo' });
    await client.transcribe(pcm, 'en');
    check('configured model rides the model form part', modelPartOf(body()) === 'whisper-large-v3-turbo', `got ${JSON.stringify(modelPartOf(body()))}`);
  }
  // No model configured → today's wire, byte-for-byte: whisper-1.
  {
    const body = captureFetch();
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test' });
    await client.transcribe(pcm, 'en');
    check('unconfigured → default whisper-1 (no behavior change)', modelPartOf(body()) === 'whisper-1', `got ${JSON.stringify(modelPartOf(body()))}`);
  }

  // ── the gpt-4o-transcribe family: json-only on the wire, still segments on the way out ──
  check('response format follows the model family',
    sttResponseFormatFor('whisper-1') === 'verbose_json' && sttResponseFormatFor('whisper-large-v3-turbo') === 'verbose_json'
      && sttResponseFormatFor('gpt-4o-transcribe') === 'json' && sttResponseFormatFor('gpt-4o-mini-transcribe') === 'json'
      && sttResponseFormatFor('gpt-transcribe') === 'json' && sttResponseFormatFor('gpt-4o-transcribe-diarize') === 'diarized_json');
  {
    let body = '';
    (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
      body = Buffer.from(init.body).toString('latin1');
      return new Response(JSON.stringify({ text: 'merhaba dünya', usage: { total_tokens: 9 } }), { status: 200 });
    };
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'gpt-4o-transcribe' });
    const result = await client.transcribe(new Float32Array(16000 * 2.5).fill(0.05), 'tr');   // 2.5 s window
    const fmt = body.match(/name="response_format"\r\n\r\n([^\r]*)\r\n/)?.[1];
    check('gpt-4o-transcribe asks for json and never for timestamps',
      fmt === 'json' && !body.includes('name="timestamp_granularities"'), `format=${fmt}`);
    check('a text-only reply becomes one segment spanning the submitted window',
      result.segments.length === 1 && result.segments[0].start === 0 && result.segments[0].end === 2.5
        && result.segments[0].text === 'merhaba dünya' && result.text === 'merhaba dünya' && result.duration === 2.5
        && result.language === 'tr',
      JSON.stringify(result));
  }
  {
    (globalThis as any).fetch = async () => new Response(JSON.stringify({
      text: 'bir iki', task: 'transcribe', duration: 3,
      segments: [{ id: 0, start: 0.2, end: 1.1, text: 'bir', speaker: 'A' }, { id: 1, start: 1.4, end: 2.9, text: 'iki', speaker: 'B' }],
    }), { status: 200 });
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'gpt-4o-transcribe-diarize' });
    const result = await client.transcribe(new Float32Array(16000 * 3).fill(0.05), 'tr');
    check('diarized_json segments keep their own times', result.segments.length === 2 && result.segments[1].start === 1.4
      && result.segments[1].end === 2.9 && result.duration === 3, JSON.stringify(result.segments));
  }
  {
    let body = '';
    (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
      body = Buffer.from(init.body).toString('latin1');
      return new Response(JSON.stringify({ text: 'صدای', logprobs: [{ token: 'ص', logprob: -1.3 }, { token: 'دای', logprob: -8.1 }] }), { status: 200 });
    };
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'gpt-4o-transcribe' });
    const result = await client.transcribe(new Float32Array(16000).fill(0.02), 'tr');
    check('json models are asked for token logprobs', body.includes('name="include[]"\r\n\r\nlogprobs'));
    check('a low-confidence text-only reply is dropped by the shared gate (mean logprob −4.7 < −1.3)',
      result.segments.length === 0 && result.text === '', JSON.stringify(result));
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ text: 'merhaba', logprobs: [{ token: 'mer', logprob: -0.01 }, { token: 'haba', logprob: -0.02 }] }), { status: 200 });
    const good = await client.transcribe(new Float32Array(16000).fill(0.02), 'tr');
    check('a confident reply keeps its segment and carries the mean as avg_logprob',
      good.segments.length === 1 && Math.abs((good.segments[0].avg_logprob ?? 0) + 0.015) < 1e-9, JSON.stringify(good));
  }
  // ── the context prompt is Whisper-only: gpt-4o-transcribe echoes it back on a quiet window ──
  {
    let body = '';
    (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
      body = Buffer.from(init.body).toString('latin1');
      return new Response(JSON.stringify({ text: 'devam', logprobs: [{ token: 'devam', logprob: -0.01 }] }), { status: 200 });
    };
    const gpt = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'gpt-4o-transcribe' });
    await gpt.transcribe(new Float32Array(16000).fill(0.02), 'tr', 'onceki onaylanan metin');
    check('gpt-4o-transcribe is never handed the previous text as a prompt (it echoes it as the transcription)',
      !body.includes('name="prompt"'), body.slice(0, 200));
    (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
      body = Buffer.from(init.body).toString('latin1');
      return new Response(JSON.stringify({ text: 'devam', segments: [] }), { status: 200 });
    };
    const whisper = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'whisper-1' });
    await whisper.transcribe(new Float32Array(16000).fill(0.02), 'tr', 'onceki onaylanan metin');
    check('whisper still receives the previous text as its context prompt',
      body.includes('name="prompt"\r\n\r\nonceki onaylanan metin'), body.slice(0, 200));
  }
  {
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ text: '' }), { status: 200 });
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'gpt-4o-transcribe' });
    const result = await client.transcribe(new Float32Array(16000).fill(0), 'tr');
    check('an empty reply stays empty — no phantom segment for silence', result.segments.length === 0 && result.text === '');
  }

  (globalThis as any).fetch = realFetch;
  if (failed) { console.error(`\n❌ stt model: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ stt model (P5, #522): the wire carries the configured model id; unset stays whisper-1; the gpt-4o-transcribe family rides json and still yields timed segments.');
}
run().catch((e) => { console.error(e); process.exit(1); });
