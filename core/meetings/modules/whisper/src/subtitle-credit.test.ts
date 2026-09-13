import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

const { TranscriptionClient } = await import(process.env.VEXA_SUBTITLE_CLIENT_MODULE || './transcription-client.js');

test('the STT HTTP boundary removes Turkish subtitle credits while preserving speech', async (t) => {
  let response;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new TranscriptionClient({ serviceUrl: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
  const pcm = new Float32Array(1600).fill(0.1);
  const segment = (text, extra = {}) => ({ text, start: 1, end: 2, no_speech_prob: 0, avg_logprob: -0.1, compression_ratio: 1, words: undefined, ...extra });
  const transcribe = async (text, segments) => {
    response = { text, segments, language: 'tr', duration: 3 };
    return client.transcribe(pcm, 'tr');
  };
  try {
    for (const text of ['Altyazı M.K.', 'ALTYAZI M.K.', 'ALTYAZİ M.K.', 'Altyazi MK', 'Alt yazı M. K.', ' Altyazı: M.K. ', 'Altyazı M.K. tarafından', 'Altyazı çevirmeni M.K.']) {
      await t.test(`drops ${JSON.stringify(text)} despite healthy confidence`, async () => {
        const result = await transcribe(text, [segment(text)]);
        assert.equal(result.text, ''); assert.deepEqual(result.segments, []);
      });
    }
    await t.test('keeps the real segment beside a separate credit segment', async () => {
      const real = segment('Raporu yarın gönderirim.', { start: 2, end: 3 });
      const result = await transcribe('Altyazı M.K. Raporu yarın gönderirim.', [segment('Altyazı M.K.'), real]);
      assert.equal(result.text, real.text); assert.deepEqual(result.segments, [real]);
    });
    await t.test('removes inline credits and their word timestamps without losing surrounding speech', async () => {
      const words = ['Merhaba.', 'Altyazı', 'M.K.', 'Rapor', 'hazır.'].map((word, i) => ({ word, start: i / 3, end: (i + 1) / 3, probability: 0.99 }));
      const result = await transcribe('Merhaba. Altyazı M.K. Rapor hazır.', [segment('Merhaba. Altyazı M.K. Rapor hazır.', { words })]);
      assert.equal(result.text, 'Merhaba. Rapor hazır.');
      assert.deepEqual(result.segments[0].words, [words[0], words[3], words[4]]);
      assert.equal(result.segments[0].start, 1); assert.equal(result.segments[0].end, 2);
    });
    await t.test('omits incompatible word alignment rather than reintroducing the removed credit', async () => {
      const result = await transcribe('Altyazı M.K. Rapor hazır.', [segment('Altyazı M.K. Rapor hazır.', { words: [{ word: 'Unrelated words', start: 0, end: 1, probability: 1 }] })]);
      assert.equal(result.text, 'Rapor hazır.'); assert.equal(result.segments[0].words, undefined);
    });
    await t.test('cleans credits split across segment boundaries and preserves retained word objects', async () => {
      const word = (word, start) => ({ word, start, end: start + 0.5, probability: 1 });
      const before = word('Rapor.', 0), credit1 = word('Altyazı', 1), credit2 = word('M.K.', 2), after = word('Hazır.', 3);
      const result = await transcribe('Rapor. Altyazı M.K. Hazır.', [segment('Rapor. Altyazı', { words: [before, credit1] }), segment('M.K. Hazır.', { words: [credit2, after] })]);
      assert.equal(result.text, 'Rapor. Hazır.');
      assert.deepEqual(result.segments.map(s => s.words), [[before], [after]]);
    });
    await t.test('handles repeated credits and split initial tokens', async () => {
      const words = ['Altyazı', 'M.', 'K.', 'Hazır.', 'Alt', 'yazı', 'M.K.'].map((word, i) => ({ word, start: i, end: i + 0.5, probability: 1 }));
      const result = await transcribe('Altyazı M. K. Hazır. Alt yazı M.K.', [segment('Altyazı M. K. Hazır. Alt yazı M.K.', { words })]);
      assert.equal(result.text, 'Hazır.'); assert.deepEqual(result.segments[0].words, [words[3]]);
    });
    await t.test('also cleans providers returning only top-level text', async () => {
      assert.equal((await transcribe('Altyazı M.K.', [])).text, '');
      assert.equal((await transcribe('Rapor hazır. Altyazı M.K.', [])).text, 'Rapor hazır.');
    });
    await t.test('does not invent a credit by dropping intervening low-confidence speech', async () => {
      const before = segment('Altyazı'), after = segment('M.K. hazırladı.');
      const result = await transcribe('Altyazı dosyasını M.K. hazırladı.', [before, segment('dosyasını', { avg_logprob: -2 }), after]);
      assert.equal(result.text, 'Altyazı M.K. hazırladı.');
      assert.deepEqual(result.segments, [before, after]);
    });
    for (const text of ['Altyazı dosyasını yarın gönderirim.', 'Altyazı M. Kaya tarafından hazırlandı.', 'M.K. raporu hazırladı.', 'Evet.', 'Tamam.', 'Thank you.']) {
      await t.test(`preserves legitimate speech ${JSON.stringify(text)}`, async () => {
        const original = segment(text);
        const result = await transcribe(text, [original]);
        assert.equal(result.text, text); assert.deepEqual(result.segments, [original]);
      });
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
