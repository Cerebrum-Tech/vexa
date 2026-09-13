"use client";
/** DateTimePicker — a compact, dependency-free date+time picker (popover calendar + time slots).
 *
 *  Replaces the native `datetime-local` input (tiny hit-targets, locale-hostile formatting) on the
 *  planned-meeting surfaces. One button shows the friendly value ("13 Tem Pzt · 10:00"); clicking
 *  opens a popover with quick-pick chips, a month grid, a TYPED time field and a 15-minute time
 *  list. Emits an ISO string via `onChange` when BOTH halves are chosen (picking a day keeps the
 *  current time; picking a time keeps the current day). `onClear` (optional) renders a
 *  "Saati kaldır" action — clearing a planned meeting's time flips it back to `idle`.
 *
 *  The slot list is a CONVENIENCE, never the vocabulary: real meetings start at 17:35, and a picker
 *  that can only express quarter-hours makes the user round their own calendar to fit the tool. The
 *  typed field accepts any minute, so the list is there for the common case and never in the way of
 *  the uncommon one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

// The surface is Turkish, so every rendered date/time is formatted against tr-TR — the browser's
// default locale never decides what a Turkish user reads.
const LOCALE = "tr-TR";
const DAYS = ["Pt", "Sa", "Ça", "Pe", "Cu", "Ct", "Pa"];
const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

function fmtValue(d: Date): string {
  return `${d.toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric" })} · ${d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })}`;
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function atTime(day: Date, h: number, m: number): Date {
  const d = new Date(day); d.setHours(h, m, 0, 0); return d;
}
/** Parse a typed time into `{h, m}`, or `null` when it is not a time.
 *
 *  Deliberately forgiving about SEPARATOR and PADDING, strict about RANGE. People type `9:05`,
 *  `09.05`, `0905` and `9` for the same instant, and rejecting any of those teaches them to distrust
 *  the field; but `25:00` is not a lenient spelling of anything, so it is refused rather than
 *  silently clamped to a time the user did not ask for.
 *
 *  A bare number is read the way a person means it: `9` is 09:00, `930` is 09:30, `1735` is 17:35.
 */
export function parseTimeInput(raw: string): { h: number; m: number } | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  let h: number;
  let m: number;
  const separated = text.match(/^(\d{1,2})\s*[:.,\s]\s*(\d{1,2})$/);
  if (separated) {
    h = Number(separated[1]);
    m = Number(separated[2]);
  } else if (/^\d{1,2}$/.test(text)) {
    h = Number(text);
    m = 0;
  } else if (/^\d{3,4}$/.test(text)) {
    h = Number(text.slice(0, text.length - 2));
    m = Number(text.slice(-2));
  } else {
    return null;
  }
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** `HH:MM` for the typed field. */
export function formatTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Round UP to the next quarter-hour boundary — the default for a fresh plan. */
export function nextHalfHour(from = new Date()): Date {
  const d = new Date(from); d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + (15 - (d.getMinutes() % 15)));
  return d;
}

const chipStyle = {
  fontSize: 11.5, padding: "3px 9px", borderRadius: 12, border: "1px solid var(--line)",
  background: "var(--panel)", color: "var(--t2)", cursor: "pointer", whiteSpace: "nowrap",
} as const;

export function DateTimePicker({ value, onChange, onClear, disabled, placeholder = "Saat seçin" }: {
  value?: string;                       // ISO8601 (or undefined = unset)
  onChange: (iso: string) => void;
  onClear?: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }, [value]);
  const [viewMonth, setViewMonth] = useState(() => selected ?? new Date());
  const ref = useRef<HTMLDivElement>(null);
  const timeListRef = useRef<HTMLDivElement>(null);
  const timeInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const discarded = useRef(false);
  const [popupLeft, setPopupLeft] = useState(0);
  const [popupWidth, setPopupWidth] = useState(362);
  // The typed field is a DRAFT until it parses: we never rewrite what someone is halfway through
  // typing ("17:" is a legal keystroke on the way to "17:35"), and we never commit a time they did
  // not finish expressing. `null` error means "nothing typed yet or it parsed".
  const [timeText, setTimeText] = useState("");
  const [timeBad, setTimeBad] = useState(false);

  // scroll the time list to the selected (or working-hours) slot when the popover opens
  // Re-seed the draft from the real value each time the popover opens, so it always shows what is
  // actually set rather than the last thing anyone typed into it.
  useEffect(() => {
    if (!open) return;
    setTimeText(selected ? formatTimeInput(selected) : "");
    setTimeBad(false);
  }, [open, selected]);

  useEffect(() => {
    if (!open || !timeListRef.current) return;
    const idx = selected ? selected.getHours() * 4 + Math.floor(selected.getMinutes() / 15) : 36; // 09:00
    timeListRef.current.scrollTop = Math.max(0, idx * 26 - 52);
  }, [open, selected]);

  const base = selected ?? nextHalfHour();
  const pickDay = (day: Date) => {
    const typed = timeText.trim() ? parseTimeInput(timeText) : null;
    if (timeText.trim() && !typed) { setTimeBad(true); return; }
    onChange(atTime(day, typed?.h ?? base.getHours(), typed?.m ?? base.getMinutes()).toISOString());
  };
  const pickTime = (h: number, m: number) => onChange(atTime(base, h, m).toISOString());
  /** Commit a valid draft before the next outside action can consume the selected date. */
  const commitTyped = useCallback((): boolean => {
    if (discarded.current) return true;
    if (!timeText.trim()) { setTimeBad(false); return true; }
    const parsed = parseTimeInput(timeText);
    if (!parsed) { setTimeBad(true); return false; }
    setTimeBad(false);
    if (selected && selected.getHours() === parsed.h && selected.getMinutes() === parsed.m) return true;
    onChange(atTime(selected ?? nextHalfHour(), parsed.h, parsed.m).toISOString());
    return true;
  }, [timeText, selected, onChange]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!ref.current || ref.current.contains(event.target as Node)) return;
      let valid = false;
      // Keyboard clicks and submit events can follow immediately in this same event turn.
      flushSync(() => { valid = commitTyped(); if (valid) setOpen(false); });
      if (!valid) {
        event.preventDefault(); event.stopImmediatePropagation();
        timeInputRef.current?.focus();
      }
    };
    const events = ["pointerdown", "mousedown", "click", "submit"] as const;
    for (const name of events) document.addEventListener(name, outside, true);
    return () => { for (const name of events) document.removeEventListener(name, outside, true); };
  }, [open, commitTyped]);

  useEffect(() => {
    if (!open) return;
    const align = () => {
      const left = ref.current?.getBoundingClientRect().left ?? 0;
      const width = Math.min(362, window.innerWidth - 32);
      setPopupWidth(width);
      setPopupLeft(Math.max(16 - left, Math.min(0, window.innerWidth - 16 - left - width)));
    };
    align(); window.addEventListener("resize", align); window.addEventListener("scroll", align, true);
    return () => { window.removeEventListener("resize", align); window.removeEventListener("scroll", align, true); };
  }, [open]);

  // month grid (Monday-first)
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const today = new Date();

  const quick: { label: string; d: Date }[] = [
    { label: "1 saat sonra", d: nextHalfHour(new Date(Date.now() + 3600_000)) },
    { label: "Bugün 17:00", d: atTime(today, 17, 0) },
    { label: "Yarın 09:00", d: atTime(new Date(Date.now() + 86400_000), 9, 0) },
    { label: "Yarın 14:00", d: atTime(new Date(Date.now() + 86400_000), 14, 0) },
  ].filter((q) => q.d.getTime() > Date.now());

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block", minWidth: 0 }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); discarded.current = true; setOpen(false); triggerRef.current?.focus();
        }
      }}>
      <button ref={triggerRef} type="button" aria-label="Tarih ve saat" aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
        onClick={() => {
          if (open) { if (commitTyped()) setOpen(false); else timeInputRef.current?.focus(); }
          else { discarded.current = false; setViewMonth(selected ?? new Date()); setOpen(true); }
        }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, padding: "6px 10px",
          background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 7,
          color: selected ? "var(--t1)" : "var(--t3)", cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.6 : 1, whiteSpace: "nowrap",
        }}>
        <span aria-hidden style={{ fontSize: 12, lineHeight: 1, opacity: 0.7 }}>🗓</span>
        {selected ? fmtValue(selected) : placeholder}
      </button>
      {open && (
        <div role="dialog" aria-label="Tarih ve saat seçin"
          style={{ position: "absolute", top: "100%", left: popupLeft, marginTop: 6, zIndex: 60, width: popupWidth, boxSizing: "border-box", maxHeight: "80dvh", overflowY: "auto",
            background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10,
            boxShadow: "0 10px 32px rgba(0,0,0,.35)", padding: 12 }}>
          {quick.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {quick.map((q) => (
                <button key={q.label} type="button" style={chipStyle}
                  onClick={() => { onChange(q.d.toISOString()); setOpen(false); }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--panel)")}>
                  {q.label}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {/* calendar */}
            <div style={{ flex: "1 1 196px", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <button type="button" aria-label="Önceki ay"
                  onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
                  style={{ background: "transparent", border: "none", color: "var(--t2)", cursor: "pointer", fontSize: 13, padding: "0 6px" }}>‹</button>
                <span style={{ flex: 1, textAlign: "center", fontSize: 12, fontWeight: 600, color: "var(--t1)" }}>
                  {MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}
                </span>
                <button type="button" aria-label="Sonraki ay"
                  onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
                  style={{ background: "transparent", border: "none", color: "var(--t2)", cursor: "pointer", fontSize: 13, padding: "0 6px" }}>›</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1 }}>
                {DAYS.map((d) => (
                  <span key={d} style={{ fontSize: 9.5, color: "var(--t3)", textAlign: "center", padding: "2px 0", textTransform: "uppercase" }}>{d}</span>
                ))}
                {Array.from({ length: lead }).map((_, i) => <span key={`x${i}`} />)}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), i + 1);
                  const isSel = selected != null && sameDay(day, selected);
                  const isToday = sameDay(day, today);
                  const past = atTime(day, 23, 59).getTime() < Date.now();
                  return (
                    <button key={i} type="button" disabled={past} onClick={() => pickDay(day)}
                      style={{
                        fontSize: 11.5, padding: "4px 0", borderRadius: 6, cursor: past ? "default" : "pointer",
                        border: isToday && !isSel ? "1px solid var(--line2)" : "1px solid transparent",
                        background: isSel ? "var(--accent)" : "transparent",
                        color: isSel ? "var(--bg)" : past ? "var(--t3)" : "var(--t1)",
                        opacity: past ? 0.45 : 1, fontWeight: isSel ? 650 : 400,
                      }}
                      onMouseEnter={(e) => { if (!isSel && !past) e.currentTarget.style.background = "var(--panel2)"; }}
                      onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}>
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* time: a typed field over the slot list. The field is outside the scroll container so
                it stays reachable however far down the list you are. */}
            <div style={{ flex: "1 1 96px", display: "flex", flexDirection: "column", borderLeft: "1px solid var(--line)", paddingLeft: 10, minWidth: 0 }}>
              <label style={{ fontSize: 10.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>
                Saat
              </label>
              <input
                ref={timeInputRef}
                value={timeText}
                inputMode="numeric"
                placeholder="ss:dd"
                aria-label="Saati yazın"
                aria-invalid={timeBad || undefined}
                onChange={(e) => { setTimeText(e.target.value); setTimeBad(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); if (commitTyped()) setOpen(false); }
                }}
                onBlur={() => commitTyped()}
                style={{
                  width: "100%", boxSizing: "border-box", marginBottom: 6, padding: "5px 8px",
                  fontSize: 12.5, fontFamily: "var(--mono)", textAlign: "center",
                  background: "var(--panel2)", color: "var(--t1)", borderRadius: 6,
                  border: `1px solid ${timeBad ? "var(--danger)" : "var(--line)"}`, outline: "none",
                }}
              />
              {timeBad && (
                <div role="alert" style={{ fontSize: 10.5, color: "var(--danger)", marginBottom: 6, lineHeight: 1.35 }}>
                  Geçerli bir saat yazın (örn. 17:35)
                </div>
              )}
              <div ref={timeListRef} style={{ flex: 1, maxHeight: 208, overflowY: "auto" }}>
              {Array.from({ length: 96 }).map((_, i) => {
                const h = Math.floor(i / 4), m = (i % 4) * 15;
                const label = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
                const isSel = selected != null && selected.getHours() === h
                  && selected.getMinutes() - (selected.getMinutes() % 15) === m;
                return (
                  <button key={label} type="button" onClick={() => { pickTime(h, m); setOpen(false); }}
                    style={{
                      display: "block", width: "100%", textAlign: "center", fontSize: 12, height: 26,
                      borderRadius: 6, border: "none", cursor: "pointer",
                      background: isSel ? "var(--accent)" : "transparent",
                      color: isSel ? "var(--bg)" : "var(--t2)", fontWeight: isSel ? 650 : 400,
                      fontFamily: "var(--mono)",
                    }}
                    onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "var(--panel2)"; }}
                    onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}>
                    {label}
                  </button>
                );
              })}
              </div>
            </div>
          </div>
          {onClear && (
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => { onClear(); setOpen(false); }}
                style={{ fontSize: 11.5, background: "transparent", border: "none", color: "var(--t3)", cursor: "pointer", textDecoration: "underline" }}>
                Saati kaldır (plan beklemede kalır)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
