"use client";
/** BrowserSupportNotice — a one-time popup for Safari users: the assistant is built and tested on
 *  Chrome- and Firefox-based browsers, and Safari is not supported. Shown once per browser session
 *  (sessionStorage), dismissible, rendered above the sign-in page so a Safari user hears it before
 *  anything else misbehaves. Detection is pure so it can be tested against user-agent strings. */
import { useEffect, useState, type CSSProperties } from "react";
import { Modal } from "../ui-kit/Modal";

const SESSION_KEY = "vexa.terminal.browserNoticeSeen";

/** True for Safari proper (macOS, iOS, iPadOS) and for WebKit views that identify as Apple's.
 *  Every other engine that embeds "Safari/" in its UA for compatibility (Chrome, Edge, Opera, Brave,
 *  Samsung, Firefox and Chrome on iOS) names itself elsewhere in the string and is excluded. */
export function isSafari(userAgent: string, vendor = ""): boolean {
  const ua = userAgent || "";
  if (!/AppleWebKit/i.test(ua)) return false;
  if (/(Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|Opera|FxiOS|Firefox|SamsungBrowser|YaBrowser|Brave|Vivaldi|DuckDuckGo)/i.test(ua)) return false;
  return /Apple/i.test(vendor) || /Version\/[\d.]+.*Safari\//.test(ua);
}

function alreadySeen(): boolean {
  try { return window.sessionStorage.getItem(SESSION_KEY) === "1"; } catch { return false; }
}
function markSeen() {
  try { window.sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* private mode or blocked storage: show again next load */ }
}

export function BrowserSupportNotice() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (isSafari(navigator.userAgent, navigator.vendor) && !alreadySeen()) setOpen(true);
  }, []);
  if (!open) return null;

  const close = () => { markSeen(); setOpen(false); };
  const body: CSSProperties = { fontSize: 13.5, color: "var(--t2)", lineHeight: 1.55 };
  const button: CSSProperties = { marginTop: 16, padding: "9px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "var(--accent)", color: "var(--on-accent)", border: "1px solid var(--accent)" };

  return (
    <Modal title="Safari desteklenmiyor" onClose={close} width={420}>
      <div style={body} data-testid="browser-support-notice">
        <p style={{ margin: 0 }}>
          Innova Toplantı Asistanı, Safari tarayıcısında düzgün çalışmayabilir. Sorunsuz bir deneyim için
          lütfen <strong style={{ color: "var(--t1)" }}>Chrome</strong> veya <strong style={{ color: "var(--t1)" }}>Firefox</strong> tabanlı
          bir tarayıcı (Chrome, Edge, Brave, Firefox) kullanın.
        </p>
        <button onClick={close} style={button}>Anladım</button>
      </div>
    </Modal>
  );
}
