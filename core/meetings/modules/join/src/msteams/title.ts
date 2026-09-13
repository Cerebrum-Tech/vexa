import type { Page } from "playwright";

/** Read the platform's subject, never a generic page heading or participant name.
 * Metadata is best-effort: a missing title or a closing page cannot fail admission. */
export async function readTeamsMeetingTitle(page: Page): Promise<string | undefined> {
  try {
    const value = await page.evaluate(() => {
      const subject = document.querySelector('[data-tid="meeting-title"]')?.textContent;
      if (subject?.trim()) return subject;
      const title = document.title.trim();
      const suffix = title.match(/^(.+?)\s*[|–—-]\s*Microsoft Teams$/i);
      const prefix = title.match(/^Microsoft Teams\s*[|–—-]\s*(.+)$/i);
      return suffix?.[1] ?? prefix?.[1] ?? null;
    });
    if (typeof value !== "string") return undefined;
    const title = value.replace(/\s+/g, " ").trim();
    if (!title || title.length > 500) return undefined;
    if (/^(?:Microsoft Teams|Teams|Join conversation|Join meeting|Join a meeting|Meet now|Meeting|Sign in|Calling|Microsoft Teams meeting|Toplantıya katıl|Şimdi toplantı yap|Oturum aç)$/i.test(title)) return undefined;
    return title;
  } catch {
    return undefined;
  }
}
