/** "Kayıt yükle" — the upload surface's two jobs: send the file, and make the wait legible.
 *
 *  The interesting behaviour is not the POST (it is one FormData), it is what the user is told
 *  while a 45-minute recording is being transcribed: browser upload percent first, then the
 *  SERVER's own transcribed/total, then done — or the server's own failure reason, never a generic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { UploadRecordingButton, transcribePercent, failureText, ACCEPTED } from "../uploadRecording";

vi.mock("../liveMeetings", () => ({ refreshMeetings: vi.fn() }));

// ── a controllable XMLHttpRequest double (fetch reports no UPLOAD progress, which is why the
//    component uses XHR at all — so the double has to carry the same seam). ──
class FakeXHR {
  static last: FakeXHR | null = null;
  status = 0;
  responseText = "";
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: FormData | null = null;
  opened: [string, string] | null = null;
  constructor() { FakeXHR.last = this; }
  open(method: string, url: string) { this.opened = [method, url]; }
  send(body: FormData) { this.sent = body; }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

let fetchMock: ReturnType<typeof vi.fn>;
const realXHR = globalThis.XMLHttpRequest;

beforeEach(() => {
  vi.useFakeTimers();
  FakeXHR.last = null;
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.XMLHttpRequest = realXHR;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pickFile(name = "toplanti.mp4") {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array(16)], name, { type: "video/mp4" });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

describe("transcribePercent", () => {
  it("is null until the recording has been decoded (there is nothing honest to draw yet)", () => {
    expect(transcribePercent(undefined)).toBeNull();
    expect(transcribePercent({ duration_seconds: null, transcribed_seconds: 0 })).toBeNull();
    expect(transcribePercent({ duration_seconds: 0 })).toBeNull();
  });

  it("is the server's own transcribed/total, clamped", () => {
    expect(transcribePercent({ duration_seconds: 600, transcribed_seconds: 150 })).toBe(25);
    expect(transcribePercent({ duration_seconds: 600, transcribed_seconds: 900 })).toBe(100);
    expect(transcribePercent({ duration_seconds: 600, transcribed_seconds: -5 })).toBe(0);
  });
});

describe("failureText", () => {
  it("names the real reason for each refusal the backend can give", () => {
    expect(failureText(413, null)).toContain("çok büyük");
    expect(failureText(415, { detail: "Unsupported file type .pdf" })).toContain(".pdf");
    expect(failureText(503, null)).toContain("TRANSCRIPTION_SERVICE_URL");
    expect(failureText(401, null)).toContain("giriş");
  });

  it("prefers the server's detail over a generic when there is one", () => {
    expect(failureText(500, { detail: "sunucu hatası X" })).toContain("sunucu hatası X");
  });

  it("never swallows an unmapped status — the user must be able to read it back to us", () => {
    // The first real field failure was a 400 from a hop that never reached our handler. The user
    // could only report "kayıt yüklenemedi", which named neither the status nor the layer.
    const msg = failureText(400, null);
    expect(msg).toContain("400");
    expect(msg).toMatch(/ara katman/);      // says it may not be our own code answering
  });

  it("says so when the request never completed at all", () => {
    expect(failureText(0, null)).toMatch(/bağlantı tamamlanmadı/);
  });
});

describe("the upload surface", () => {
  it("opens the accepted recording's canonical meeting without starting another upload", () => {
    const onOpen = vi.fn();
    render(<UploadRecordingButton onOpen={onOpen} />);
    expect(screen.queryByRole("button", { name: "Transkripti aç" })).toBeNull();
    pickFile();
    act(() => { FakeXHR.last!.respond(202, { id: 42, status: "requested" }); });
    fireEvent.click(screen.getByRole("button", { name: "Transkripti aç" }));
    expect(onOpen).toHaveBeenCalledWith(42);
  });
  it("offers the picker the extensions the backend accepts", () => {
    render(<UploadRecordingButton />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe(ACCEPTED);
    for (const ext of [".mp4", ".mkv", ".m4a", ".wav"]) expect(ACCEPTED).toContain(ext);
  });

  it("POSTs the file and shows the browser's upload percent while the bytes move", () => {
    render(<UploadRecordingButton />);
    pickFile("haftalık toplantı.mp4");
    const xhr = FakeXHR.last!;
    expect(xhr.opened).toEqual(["POST", "/api/uploads"]);
    expect(xhr.sent?.get("file")).toBeInstanceOf(File);
    expect(xhr.sent?.get("title")).toBe("haftalık toplantı");   // the extension is not the title
    expect(xhr.sent?.get("language")).toBe("tr");
    act(() => { xhr.upload.onprogress?.({ lengthComputable: true, loaded: 30, total: 120 }); });
    expect(screen.getByText(/Yükleniyor — %25/)).toBeTruthy();
  });

  it("switches to the server's transcription progress once the upload is accepted", async () => {
    render(<UploadRecordingButton />);
    pickFile();
    act(() => { FakeXHR.last!.respond(202, { id: 42, status: "requested", upload: { state: "queued" } }); });
    expect(screen.getByText(/çözümleniyor/)).toBeTruthy();   // no duration yet ⇒ no false percentage

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, status: "active",
                           upload: { state: "transcribing", duration_seconds: 3600, transcribed_seconds: 900 } }),
    } as unknown as Response);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fetchMock).toHaveBeenCalledWith("/api/uploads?id=42", { cache: "no-store" });
    expect(screen.getByText(/Yazıya dökülüyor — %25/)).toBeTruthy();
  });

  it("stops polling and points at the list when the meeting completes", async () => {
    render(<UploadRecordingButton />);
    pickFile();
    act(() => { FakeXHR.last!.respond(202, { id: 42, status: "requested" }); });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, status: "completed",
                           upload: { state: "done", duration_seconds: 60, transcribed_seconds: 60 } }),
    } as unknown as Response);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText(/Transkript hazır\. Toplantı özeti ayrıca hazırlanır\./)).toBeTruthy();
    const callsAfterDone = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(fetchMock.mock.calls.length).toBe(callsAfterDone);   // the poll really stopped
  });

  it("surfaces the job's OWN failure reason, not a generic one", async () => {
    render(<UploadRecordingButton />);
    pickFile();
    act(() => { FakeXHR.last!.respond(202, { id: 42, status: "requested" }); });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, status: "failed",
                           upload: { state: "failed", error: "the file carries no audio track" } }),
    } as unknown as Response);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("alert").textContent).toContain("no audio track");
  });

  it("refuses the upload out loud when the deployment has no transcription backend", () => {
    render(<UploadRecordingButton />);
    pickFile();
    act(() => { FakeXHR.last!.respond(503, { detail: "Transcription is not configured" }); });
    expect(screen.getByRole("alert").textContent).toContain("TRANSCRIPTION_SERVICE_URL");
  });
});
