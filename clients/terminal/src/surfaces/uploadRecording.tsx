/** "Kayıt yükle" — an audio or video recording of a meeting nobody sent a bot to.
 *
 *  The file goes to `POST /api/uploads`, which mints a meeting row and queues the transcription
 *  job; from there the recording is a meeting like any other — it appears in the list, its
 *  transcript fills in, and it gets the same post-meeting report. This component's whole job is to
 *  make the wait legible: the browser's upload progress while the bytes move, then the server's own
 *  `transcribed_seconds / duration_seconds` while it is being transcribed.
 *
 *  XMLHttpRequest, not fetch, for exactly one reason: `fetch` reports no UPLOAD progress, and a
 *  400 MB file with no progress bar is indistinguishable from a hung app.
 */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { refreshMeetings } from "./liveMeetings";

/** What the file picker offers.
 *
 *  The extension list mirrors `uploads/router.py` MEDIA_EXTENSIONS, and `audio/*,video/*` is there
 *  for the devices that write something this list has not heard of — the backend accepts an unknown
 *  extension too and lets ffmpeg decide by reading the bytes, so the picker must not be the
 *  narrower gate.
 */
export const ACCEPTED = "audio/*,video/*," +
  ".3g2,.3ga,.3gp,.aac,.ac3,.adts,.aif,.aifc,.aiff,.alac,.amr,.ape,.asf,.au,.avi,.awb,.bwf,.caf,.dff,.divx,.dsf,.dts,.dv,.eac3,.f4v,.flac,.flv,.gsm,.m1v,.m2p,.m2ts,.m2v,.m4a,.m4b,.m4r,.m4v,.mka,.mkv,.mov,.mp2,.mp3,.mp4,.mpc,.mpe,.mpeg,.mpg,.mpga,.mts,.mxf,.oga,.ogg,.ogv,.ogx,.opus,.qt,.ra,.rm,.rmvb,.shn,.sln,.snd,.spx,.swf,.ts,.tta,.vob,.voc,.w64,.wav,.wave,.weba,.webm,.wma,.wmv,.wv,.y4m";

export type UploadPhase = "idle" | "uploading" | "transcribing" | "done" | "error";

export interface UploadRecord {
  state?: string;
  duration_seconds?: number | null;
  transcribed_seconds?: number | null;
  segments?: number;
  error?: string | null;
}

export interface UploadStatus {
  id: number;
  status: string;
  upload?: UploadRecord;
}

/** Server-side progress as a 0–100 integer, or null while the duration is still unknown (the file
 *  has not been decoded yet, so there is nothing honest to draw). */
export function transcribePercent(u: UploadRecord | undefined): number | null {
  const total = u?.duration_seconds;
  if (!total || total <= 0) return null;
  const done = Math.max(0, Math.min(total, u?.transcribed_seconds ?? 0));
  return Math.round((done / total) * 100);
}

/** The message for a failed upload: the server's own reason when it gave one, never a generic.
 *
 *  An UNMAPPED status must still say what happened. The first version ended in a bare
 *  "Kayıt yüklenemedi." for anything it did not recognise, and the first real failure in the field
 *  was exactly that: a 400 from a hop that never reached our own handler, reported to the user — and
 *  therefore to us — as four words with no status, no reason, and nothing to search a log for. A
 *  message a user can read back to you is the difference between a diagnosis and a guessing game.
 */
export function failureText(status: number, body: unknown): string {
  const detail = (body as { detail?: string; error?: string } | null)?.detail
    ?? (body as { error?: string } | null)?.error;
  if (status === 413) return "Dosya çok büyük — daha kısa bir kayıt yükleyin.";
  if (status === 415) return detail ?? "Bu dosya türü desteklenmiyor — ses veya video yükleyin.";
  if (status === 503) return "Transkripsiyon bu kurulumda yapılandırılmamış (TRANSCRIPTION_SERVICE_URL).";
  if (status === 401) return "Oturumunuz doğrulanamadı — yeniden giriş yapın.";
  if (detail) return `${detail} (HTTP ${status})`;
  // No parsable body: the status is the only fact we have, so it is the one we report. `status === 0`
  // is XHR's "the request never completed" — a dropped connection or a hop that closed on us.
  if (!status) return "Kayıt yüklenemedi — bağlantı tamamlanmadı (sunucuya ulaşılamadı veya aktarım kesildi).";
  return `Kayıt yüklenemedi (HTTP ${status}). Bu yanıt uygulamanın kendisinden değil, önündeki bir ara katmandan geliyor olabilir.`;
}

function humanDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "";
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa ${m % 60} dk`;
}

export function UploadRecordingButton() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [sentPct, setSentPct] = useState(0);
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback((meetingId: number) => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/uploads?id=${meetingId}`, { cache: "no-store" });
          if (!r.ok) return;
          const body = (await r.json()) as UploadStatus;
          setStatus(body);
          if (body.status === "completed") {
            stopPolling(); setPhase("done"); refreshMeetings();
          } else if (body.status === "failed") {
            stopPolling(); setPhase("error");
            setError(body.upload?.error ?? "Kayıt çözümlenemedi.");
          } else {
            refreshMeetings();   // the row is already in the list; keep its status fresh
          }
        } catch { /* a dropped poll is not a failed upload — the next tick retries */ }
      })();
    }, 3000);
  }, [stopPolling]);

  const send = useCallback((file: File) => {
    setPhase("uploading"); setSentPct(0); setError(null); setStatus(null);
    const form = new FormData();
    form.append("file", file);
    form.append("title", file.name.replace(/\.[^.]+$/, ""));
    form.append("language", "tr");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setSentPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* a non-JSON body is still a failure */ }
      if (xhr.status !== 202) {
        // Console-log the raw exchange: the user sees a readable sentence, and whoever they show the
        // console to sees exactly what the server said, including a non-JSON body from an
        // intermediary that never reached our handler.
        console.error("[upload] failed", { status: xhr.status, body: xhr.responseText?.slice(0, 500) });
      }
      if (xhr.status === 202) {
        const created = body as UploadStatus;
        setStatus(created); setPhase("transcribing"); refreshMeetings(); poll(created.id);
      } else {
        setPhase("error"); setError(failureText(xhr.status, body));
      }
    };
    xhr.onerror = () => { setPhase("error"); setError("Sunucuya ulaşılamadı."); };
    xhr.send(form);
  }, [poll]);

  const pct = transcribePercent(status?.upload);
  const busy = phase === "uploading" || phase === "transcribing";

  return (
    <div style={{ marginBottom: 2 }}>
      <input ref={fileRef} type="file" accept={ACCEPTED} style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) send(f); }} />
      <button onClick={() => fileRef.current?.click()} disabled={busy}
        title="Bir toplantı kaydını (ses veya video) yükleyip transkriptini ve raporunu çıkarın"
        style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "1px dashed var(--line2)", color: busy ? "var(--t3)" : "var(--t2)", borderRadius: 7, padding: "6px 9px", fontSize: 12, cursor: busy ? "default" : "pointer" }}
        onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = "var(--panel2)"; }}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
        ⤒ Kayıt yükle
      </button>
      {phase === "uploading" && (
        <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 5, lineHeight: 1.4 }}>
          Yükleniyor — %{sentPct}
        </div>
      )}
      {phase === "transcribing" && (
        <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 5, lineHeight: 1.4 }}>
          {pct === null
            ? "Kayıt alındı — çözümleniyor…"
            : `Yazıya dökülüyor — %${pct}${status?.upload?.duration_seconds ? ` (${humanDuration(status.upload.duration_seconds)})` : ""}`}
        </div>
      )}
      {phase === "done" && (
        <div style={{ fontSize: 11, color: "var(--green)", marginTop: 5, lineHeight: 1.4 }}>
          Hazır — transkript ve toplantı raporu toplantılar listenizde.
        </div>
      )}
      {phase === "error" && (
        <div role="alert" style={{ fontSize: 11, color: "var(--danger)", marginTop: 5, lineHeight: 1.4 }}>{error}</div>
      )}
    </div>
  );
}
