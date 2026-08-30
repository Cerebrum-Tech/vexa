import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Turkish meetings UI", () => {
  it("marks the document Turkish and brands the application as Innova", () => {
    const layout = source("src/app/layout.tsx");
    expect(layout).toContain('<html lang="tr">');
    expect(layout).toContain('title: "Innova Toplantı Asistanı"');
  });

  it("uses Turkish copy on the main meetings workflow", () => {
    const copy = ["src/surfaces/today.tsx", "src/surfaces/meeting.tsx", "src/surfaces/chat.tsx", "src/canvas/MeetingCanvasView.tsx"]
      .map(source).join("\n");
    for (const text of ["Bugün", "Botu durdur", "Ham transkript", "Toplantı özeti", "Toplantıda"]) {
      expect(copy).toContain(text);
    }
    for (const text of ['"Stop bot"', '"raw transcript"', '"Ask for the recap', 'label: "In meeting"']) {
      expect(copy).not.toContain(text);
    }
  });

  it("uses Turkish copy for local model and transcription setup", () => {
    const copy = source("src/app/SetupGate.tsx") + source("src/surfaces/settings.tsx");
    for (const text of ["Yerel model", "Transkripsiyon", "Bağlantıyı test et", "Ayarlar"]) {
      expect(copy).toContain(text);
    }
  });

  it("does not expose the Vexa product name in user-facing Terminal copy", () => {
    const copy = [
      "src/app/App.tsx", "src/app/AuthGate.tsx", "src/app/SetupGate.tsx",
      "src/surfaces/apiClient.ts", "src/surfaces/calendarConnections.tsx",
      "src/surfaces/meeting.tsx", "src/surfaces/meetingsOnboarding.tsx",
      "src/surfaces/workspace.tsx", "src/surfaces/workspaceManage.tsx",
    ].map(source).join("\n");
    for (const text of ["Continue to Vexa", "Vexa instance", "Vexa server", 'placeholder="Vexa"',
      '|| "Vexa"', "Send the Vexa bot", "Vexa reads your calendar", "Vexa barındırılan",
      ">www.vexa.ai/account<", "Get your token", "No Claude credentials detected",
      '"vexa-workspace"']) {
      expect(copy).not.toContain(text);
    }
  });
});
