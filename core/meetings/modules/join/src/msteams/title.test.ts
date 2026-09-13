import assert from "node:assert/strict";
import { readTeamsMeetingTitle } from "./title";

async function main() {
  const read = async (title: string, subject?: string) => {
    const page: any = { evaluate: async (fn: any) => {
      (globalThis as any).document = {
        title,
        querySelector: (selector: string) => selector === '[data-tid="meeting-title"]' && subject
          ? { textContent: subject } : null,
      };
      try { return fn(); } finally { delete (globalThis as any).document; }
    } };
    return readTeamsMeetingTitle(page);
  };
  assert.equal(await read("Microsoft Teams", "  Haftalık   Planlama  "), "Haftalık Planlama");
  assert.equal(await read("Yol Haritası | Microsoft Teams"), "Yol Haritası");
  assert.equal(await read("Microsoft Teams | Yol Haritası"), "Yol Haritası");
  for (const title of ["Microsoft Teams", "Teams", "Join conversation | Microsoft Teams", "Meet now | Microsoft Teams", "Sign in | Microsoft Teams", "", "Unbranded browser screen"]) {
    assert.equal(await read(title), undefined, title);
  }
  assert.equal(await read("Microsoft Teams", "x".repeat(501)), undefined);
  assert.equal(await readTeamsMeetingTitle({ evaluate: async () => { throw new Error("page closed"); } } as any), undefined);
  console.log("Teams subject capture: 12 assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
