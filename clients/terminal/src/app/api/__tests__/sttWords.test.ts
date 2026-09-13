import { describe, expect, it } from "vitest";
import { lowConfidence, spreadWords, sttResponseFormatFor, wavSeconds } from "../stt/words";

describe("sttResponseFormatFor — the model-family rule the dictation proxy shares with the bot", () => {
  it("keeps Whisper on verbose_json", () => {
    expect(sttResponseFormatFor("whisper-1")).toBe("verbose_json");
    expect(sttResponseFormatFor("whisper-large-v3-turbo")).toBe("verbose_json");
    expect(sttResponseFormatFor("")).toBe("verbose_json");
  });
  it("asks the gpt-4o-transcribe family for json, and the diarize member for diarized_json", () => {
    expect(sttResponseFormatFor("gpt-4o-transcribe")).toBe("json");
    expect(sttResponseFormatFor("gpt-4o-mini-transcribe")).toBe("json");
    expect(sttResponseFormatFor("gpt-4o-transcribe-diarize")).toBe("diarized_json");
  });
});

describe("spreadWords — text-only replies still drive the composer's confirm loop", () => {
  it("spreads words evenly over the window and keeps Whisper's leading-space shape", () => {
    const words = spreadWords("merhaba dünya nasılsın", 3);
    expect(words.map((w) => w.word)).toEqual(["merhaba", " dünya", " nasılsın"]);
    expect(words[0].start).toBe(0);
    expect(words[2].end).toBe(3);
    expect(words[1].start).toBeCloseTo(1, 3);
  });
  it("yields nothing for silence or an unknown window length", () => {
    expect(spreadWords("", 3)).toEqual([]);
    expect(spreadWords("merhaba", 0)).toEqual([]);
  });
});

describe("wavSeconds — the submitted window's length from its own header", () => {
  it("reads 16 kHz mono 16-bit", () => {
    const seconds = 2.5; const rate = 16000; const n = seconds * rate * 2;
    const buf = new ArrayBuffer(44 + n); const v = new DataView(buf);
    [..."RIFF"].forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
    v.setUint32(24, rate, true); v.setUint16(32, 2, true);
    expect(wavSeconds(buf)).toBeCloseTo(2.5, 6);
  });
  it("is 0 for anything that is not a RIFF buffer", () => {
    expect(wavSeconds(new ArrayBuffer(10))).toBe(0);
  });
});

describe("lowConfidence — the family's only confidence signal", () => {
  it("flags a reply whose mean token logprob is below the shared −1.3 bar", () => {
    expect(lowConfidence([{ logprob: -1.3 }, { logprob: -8.1 }])).toBe(true);
    expect(lowConfidence([{ logprob: -0.01 }, { logprob: -0.02 }])).toBe(false);
  });
  it("treats missing logprobs as unknown, never as junk", () => {
    expect(lowConfidence(undefined)).toBe(false);
    expect(lowConfidence([])).toBe(false);
  });
});
