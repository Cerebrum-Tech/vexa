"use client";
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useService } from "../platform";
import { LayoutServiceId, type LayoutService } from "../workbench/layout";
import type { HarnessActions } from "./types";

interface CanvasActionState {
  metrics: Record<string, number | string>;
  sections: Record<string, unknown>;
}

const initialSections = {
  pinned: [] as string[],
  dismissed: [] as string[],
  notes: [] as { text: string; ts: string }[],
  tags: {} as Record<string, string[]>,
};

let state: CanvasActionState = { metrics: {}, sections: initialSections };
const subs = new Set<() => void>();

function emit(next: CanvasActionState): void {
  state = next;
  subs.forEach((fn) => fn());
}

function readSection<T>(key: string, fallback: T): T {
  const value = state.sections[key];
  return value == null ? fallback : value as T;
}

function updateSections(patch: Record<string, unknown>): void {
  emit({ ...state, sections: { ...state.sections, ...patch } });
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path || "Belge";
}

function researchPrompt(entity: { name: string; kind: string }): string {
  const name = String(entity?.name ?? "").trim() || "öne çıkan bu varlık";
  const kind = String(entity?.kind ?? "").trim() || "varlık";
  return [
    `Meeting Canvas araştırma isteği: ${kind} "${name}".`,
    "Web’i ve çalışma alanının bilgi grafiğini kullanarak araştır.",
    "kg/entities/<kind>/<slug>.md altındaki kanonik varlık belgesini kısa bir özet, kaynak notları ve toplantıyla ilgisi ile birlikte yaz ya da bu belgeye ekle.",
    "İşin bitince çalışma alanı güncellemesini commit et.",
  ].join("\n");
}

function postMeetingTurn(prompt: string, session: string): void {
  const body = JSON.stringify({ prompt, session });  // no subject — gateway injects X-User-Id; agent-api derives scope (P20)
  void fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch((err) => {
    console.warn("meeting canvas chat turn failed", err);
  });
}

export const ASK_CHAT_EVENT = "vexa:terminal:ask-chat";

// Clicking an entity link in chat (a [[wikilink]] or a kg/entities/*.md path) dispatches this; the
// workbench resolves it to a file and opens the doc (revealing the center if in chat-only mode).
export const OPEN_ENTITY_EVENT = "vexa:terminal:open-entity";

// ASCII sentinel prefixed to the onboarding grounding (robust against bundler/linter normalization). The
// agent ignores the bracketed tag; the chat uses it to recognize an onboarding turn (filter a pure
// kickoff, compact the grounding off a real reply, keep it out of the session title).
export const ONBOARDING_KICKOFF_MARK = "[onboarding-kickoff]";

// Onboarding uses a CACHED first turn (no slow LLM round-trip): the gate seeds this canned agent greeting
// instantly, then arms the chat so the user's FIRST reply carries the discovery-loop grounding.
export const ONBOARDING_SEED_EVENT = "vexa:terminal:onboarding-seed";
export const ONBOARDING_GREETING = "👋 Ben bilgi asistanınızım. Burası **sizin çalışma alanınız** — çevrenizdeki kişilerin, şirketlerin ve toplantıların yaşayan bir hafızasını kurmanıza yardımcı olurum ve bunu görüşmeler sırasında da aralarında da işinize yarar tutarım. Başlamak için: **adınız nedir?** (Dilerseniz **LinkedIn adresinizi** yapıştırın ya da ad + şirket yazın, gerisini ben hallederim.)";
// Separates the (hidden) grounding from the user's actual reply, so the reply renders alone on reload.
export const ONBOARDING_REPLY_SEP = "\n\n[reply]\n";
export const ONBOARDING_GROUNDING = ONBOARDING_KICKOFF_MARK + [
  "Yanıt vermeden önce şu çalışma alanı dosyalarını oku (Read aracıyla): onboarding.md, CLAUDE.md",
  "",
  "Kuruluma yanıt veren yeni bir kullanıcıyım. onboarding.md içindeki keşif döngüsü el kitabını izle.",
  "Önce ADIMI `_system/identity.md` dosyasına yaz (her zaman erişilebilen hafif kimlik referansı) —",
  "boş bırakmaman gereken tek bilgi budur; öğrenene kadar sormayı sürdür.",
  "LinkedIn adresi verdiysem onu ARAMA ÇIPASI olarak kullan (oradan beni ara; girişe kapalı sayfayı",
  "çekmeye ÇALIŞMA). Genel ağdaki izimi web aramasıyla kendi başına ve DERİNLEMESİNE araştır (çevrimiçi",
  "bulabileceğin bir bilgiyi bana geri sorma) ve varlıklarımı sıfırdan kur. BENİ bu çalışma alanındaki",
  "tek `self: true` kişi düğümü olarak kaydet (LinkedIn adresimi de o düğümde sakla) — tam profilim",
  "orada durur, _system içindeki hafif referans ona bağlanır. `README.md` dosyasını çalışma alanının",
  "kontrol paneli olarak güncel tut.",
  "Bana yalnızca kendi başına çözemediğin gerçek boşlukları sor — her birinin neden önemli olduğunu",
  "söyleyerek. En az iki keşif turu çalıştır. Bilgilerim:",
].join("\n");

function makeActions(layout?: LayoutService): HarnessActions {
  return {
    ask(prompt) {
      const text = String(prompt ?? "").trim();
      if (!text) return;
      // Drive the VISIBLE right-rail chat so the user sees the question + streamed answer (the rail's send
      // pipeline grounds it in the active meeting). Fall back to a direct turn if no chat is listening.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(ASK_CHAT_EVENT, { detail: { prompt: text } }));
        return;
      }
      postMeetingTurn(text, "meeting-canvas");
    },
    research(entity) {
      postMeetingTurn(researchPrompt(entity), "meeting/research");
    },
    openDoc(path) {
      const safePath = String(path ?? "").trim();
      if (!safePath) return;
      layout?.openTab({
        id: `doc:${safePath}`,
        title: baseName(safePath),
        kind: "doc",
        params: { path: safePath },
        context: null,
      });
    },
    copyRef(token) {
      const text = String(token ?? "").trim();
      if (!text) return;
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).catch((err) => {
          console.warn("meeting canvas copy failed", err);
        });
        return;
      }
      console.info("meeting canvas copy ref", text);
    },
    note(text) {
      const notes = readSection<{ text: string; ts: string }[]>("notes", []);
      updateSections({ notes: [...notes, { text, ts: new Date().toISOString() }] });
      console.info("meeting canvas note", text);
    },
    pin(id) {
      const pinned = readSection<string[]>("pinned", []);
      updateSections({ pinned: pinned.includes(id) ? pinned : [...pinned, id] });
    },
    dismiss(id) {
      const dismissed = readSection<string[]>("dismissed", []);
      updateSections({ dismissed: dismissed.includes(id) ? dismissed : [...dismissed, id] });
    },
    setMetric(key, value) {
      emit({ ...state, metrics: { ...state.metrics, [key]: value } });
    },
    tag(speaker, label) {
      const tags = readSection<Record<string, string[]>>("tags", {});
      const current = tags[speaker] ?? [];
      updateSections({ tags: { ...tags, [speaker]: current.includes(label) ? current : [...current, label] } });
    },
    export() {
      console.info("meeting canvas export", state);
    },
  };
}

const ActionsContext = createContext<HarnessActions | null>(null);

export function CanvasActionsProvider({ children }: { children: ReactNode }) {
  const layout = useService(LayoutServiceId);
  const actions = useMemo(() => makeActions(layout), [layout]);
  return createElement(ActionsContext.Provider, { value: actions }, children);
}

export function useActions(): HarnessActions {
  const actions = useContext(ActionsContext);
  return actions ?? makeActions();
}

export function useCanvasActionState(): CanvasActionState {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => state,
    () => state,
  );
}
