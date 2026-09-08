/**
 * MS Teams chat WRITER — the send half of `teams-chat.ts`, and its mirror in every respect.
 *
 * The reader watches the chat panel and emits messages; this puts one INTO it. Same constraints,
 * same defences: Teams' DOM is data-tid-driven and changes across builds, so every step works
 * through a candidate list and REPORTS what matched. A send that fails must say which step failed
 * and what it saw — a chat message that silently does not appear is indistinguishable from a bot
 * that was never asked to send one, and that is the failure this module exists to make impossible.
 *
 * Three things make writing harder than reading:
 *
 *  1. The panel must be OPEN. The compose box is not in the DOM otherwise, so we click the chat
 *     toggle and wait for it — the reader has the same requirement but merely waits.
 *  2. The compose box is a rich-text editor (contenteditable), not an <input>. Assigning
 *     `textContent` leaves the editor's own model empty, so the send button stays disabled and the
 *     message goes nowhere. `execCommand('insertText')` drives the editor the way a keystroke does
 *     and is what actually works; the direct write is kept only as a last resort.
 *  3. "Sent" is not observable from the click. We confirm by watching the compose box EMPTY —
 *     Teams clears it on send — rather than trusting that a button we found was the right one.
 *
 * Pure DOM, no network, no audio. Runs in the page.
 */

import { CONTAINER_SELECTORS } from './teams-chat.js';

export interface TeamsChatSendResult {
  ok: boolean;
  /** How far it got — the first step that failed is the one to fix. */
  step: 'panel' | 'input' | 'insert' | 'send' | 'confirm' | 'done';
  /** Whether the chat message LIST was present — the real test of "the panel is open". */
  panelOpen?: boolean;
  /** The selector of the element that is actually contenteditable (a matched wrapper is descended
   *  into), plus whether `document.activeElement` was that element after focusing. */
  editableSel?: string | null;
  activeIsEditor?: boolean;
  matchedInput: string | null;
  matchedSend: string | null;
  /** What each candidate selector matched, so a broken build can be re-tuned from live telemetry. */
  candidates: Array<{ sel: string; count: number }>;
  detail?: string;
}

export interface TeamsChatSendOptions {
  log?: (m: string) => void;
  /** How long to wait for the panel/compose box to appear. */
  timeoutMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
}

/** Opens the chat panel. Teams has moved this button across builds. */
const TOGGLE_SELECTORS = [
  '[data-tid="chat-button"]',
  '[data-tid="toggle-chat"]',
  'button[aria-label*="Chat"]',
  'button[title*="Chat"]',
  'button[aria-label*="Sohbet"]',
  'button[title*="Sohbet"]',
];

/** The compose box — a contenteditable, not an input. */
const INPUT_SELECTORS = [
  '[data-tid="ckeditor"]',
  '[data-tid="messageBodyInput"]',
  'div[contenteditable="true"][role="textbox"]',
  '.ck-editor__editable',
  'div[contenteditable="true"][aria-label*="message"]',
  'div[contenteditable="true"][aria-label*="ileti"]',
  'div[contenteditable="true"]',
];

const SEND_SELECTORS = [
  '[data-tid="sendMessageCommand"]',
  'button[name="send"]',
  'button[aria-label*="Send"]',
  'button[title*="Send"]',
  'button[aria-label*="Gönder"]',
  'button[title*="Gönder"]',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function survey(selectors: string[]): Array<{ sel: string; count: number }> {
  return selectors.map((sel) => {
    let count = 0;
    try { count = document.querySelectorAll(sel).length; } catch { count = 0; }
    return { sel, count };
  });
}

function firstVisible(selectors: string[]): { el: HTMLElement; sel: string } | null {
  for (const sel of selectors) {
    let nodes: NodeListOf<Element>;
    try { nodes = document.querySelectorAll(sel); } catch { continue; }
    for (const n of Array.from(nodes)) {
      const el = n as HTMLElement;
      // offsetParent is null for display:none; Teams keeps hidden panels mounted, and a hidden
      // compose box accepts text that no one ever sees.
      if (el.offsetParent !== null || el.getClientRects().length > 0) return { el, sel };
    }
  }
  return null;
}

/** Open the chat panel and FOCUS the compose box. Does not type.
 *
 *  Typing moved to the Node side (Playwright's keyboard) after a live run proved why: writing the
 *  text with `execCommand`/`textContent` puts it in the DOM, but Teams' rich-text editor keeps its
 *  own model — which stayed EMPTY. The send then submitted nothing and reset the box, so the DOM
 *  looked exactly like a successful send: text in, box cleared, no message. Only real key events
 *  reach the editor's model, and only Playwright can produce trusted ones.
 */
export async function focusTeamsChatInput(
  opts: TeamsChatSendOptions = {},
): Promise<TeamsChatSendResult> {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const candidates = () => survey([...INPUT_SELECTORS, ...SEND_SELECTORS, ...TOGGLE_SELECTORS]);
  const deadline = Date.now() + timeoutMs;

  // The panel is open when the MESSAGE LIST is there — not when some editor happens to be mounted.
  const panelOpen = (): boolean => !!firstVisible(CONTAINER_SELECTORS);
  if (!panelOpen()) {
    const toggle = firstVisible(TOGGLE_SELECTORS);
    if (toggle) { log(`[teams-chat-send] opening chat panel via ${toggle.sel}`); toggle.el.click(); }
    while (!panelOpen() && Date.now() < deadline) await sleep(pollMs);
  }
  if (!panelOpen()) {
    return { ok: false, step: 'panel', panelOpen: false, matchedInput: null, matchedSend: null,
             candidates: candidates(),
             detail: 'the chat message list never appeared — the panel did not open' };
  }

  let found = firstVisible(INPUT_SELECTORS);
  while (!found && Date.now() < deadline) { await sleep(pollMs); found = firstVisible(INPUT_SELECTORS); }
  if (!found) {
    return { ok: false, step: 'input', panelOpen: true, matchedInput: null, matchedSend: null,
             candidates: candidates(), detail: 'the panel is open but no compose box matched' };
  }
  // DESCEND TO THE REAL EDITOR. `[data-tid="ckeditor"]` is CKEditor 5's WRAPPER; the element that
  // takes keystrokes is the `contenteditable` inside it (`.ck-editor__editable`). Focusing or
  // clicking the wrapper does not move focus to the child — which is how 110 keystrokes were typed
  // and the box stayed empty (observed: landed_in_box=false). Any match that is not itself
  // contenteditable is descended into.
  const isEditable = (el: HTMLElement): boolean => el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  let editable: HTMLElement = found.el;
  let editableSel: string = found.sel;
  if (!isEditable(editable)) {
    const inner = found.el.querySelector('[contenteditable="true"]') as HTMLElement | null;
    if (inner) { editable = inner; editableSel = `${found.sel} [contenteditable="true"]`; }
  }
  editable.focus();
  editable.click();
  const activeIsEditor = document.activeElement === editable;
  const send = firstVisible(SEND_SELECTORS);
  return { ok: true, step: 'input', panelOpen: true, matchedInput: found.sel,
           editableSel, activeIsEditor, matchedSend: send?.sel ?? null, candidates: candidates() };
}

/** Is the real editor focused RIGHT NOW? Read just before typing, from the Node side. */
export function teamsChatEditorIsActive(): boolean {
  const active = document.activeElement as HTMLElement | null;
  return !!active && (active.isContentEditable || active.getAttribute('contenteditable') === 'true');
}

/** What the compose box currently holds — the datum that separates "the keystrokes never reached
 *  this element" from "they did, and the send failed". Without it a failed send is unattributable:
 *  every step reports success and the message simply is not there. */
export function teamsChatComposeText(): string {
  const found = firstVisible(INPUT_SELECTORS);
  return found ? (found.el.textContent ?? '') : '(no compose box)';
}

/** Has `needle` appeared in the chat's own message list? The ONLY honest proof of a send. */
export function teamsChatHasMessage(needle: string): boolean {
  const list = firstVisible(CONTAINER_SELECTORS);
  return !!list && (list.el.textContent ?? '').includes(needle);
}

/** Click the send button if one is present and enabled. Returns which selector it used. */
export function clickTeamsChatSend(): string | null {
  const send = firstVisible(SEND_SELECTORS);
  if (!send) return null;
  if ((send.el as HTMLButtonElement).disabled) return null;
  send.el.click();
  return send.sel;
}
