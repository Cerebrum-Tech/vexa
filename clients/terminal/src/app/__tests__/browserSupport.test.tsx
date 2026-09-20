/** BrowserSupportNotice — Safari gets a one-time "not supported, use Chrome or Firefox" popup; every
 *  other browser (including the ones that carry "Safari/" in their UA for compatibility) gets nothing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { BrowserSupportNotice, isSafari } from "../BrowserSupportNotice";

const UA = {
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  firefoxWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  firefoxIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15",
  brave: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

describe("isSafari", () => {
  it("flags Safari on macOS and iOS", () => {
    expect(isSafari(UA.safariMac, "Apple Computer, Inc.")).toBe(true);
    expect(isSafari(UA.safariIos, "Apple Computer, Inc.")).toBe(true);
    expect(isSafari(UA.safariMac)).toBe(true); // vendor unavailable: the Version/… Safari/ pair still identifies it
  });
  it("lets Chrome-, Edge-, Brave- and Firefox-based browsers through, on desktop and iOS", () => {
    expect(isSafari(UA.chromeMac, "Google Inc.")).toBe(false);
    expect(isSafari(UA.chromeIos, "Apple Computer, Inc.")).toBe(false);
    expect(isSafari(UA.edgeWin, "Google Inc.")).toBe(false);
    expect(isSafari(UA.firefoxWin, "")).toBe(false);
    expect(isSafari(UA.firefoxIos, "Apple Computer, Inc.")).toBe(false);
    expect(isSafari(UA.brave, "Google Inc.")).toBe(false);
    expect(isSafari("", "")).toBe(false);
  });
});

function stubBrowser(userAgent: string, vendor: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, "vendor", { value: vendor, configurable: true });
}

describe("BrowserSupportNotice", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Safari: shows the popup once per session and closes on Anladım", () => {
    stubBrowser(UA.safariMac, "Apple Computer, Inc.");
    render(<BrowserSupportNotice />);
    const dialog = screen.getByRole("dialog", { name: "Safari desteklenmiyor" });
    expect(dialog.textContent).toContain("Chrome");
    expect(dialog.textContent).toContain("Firefox");
    fireEvent.click(screen.getByText("Anladım"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.sessionStorage.getItem("vexa.terminal.browserNoticeSeen")).toBe("1");

    cleanup();
    render(<BrowserSupportNotice />);
    expect(screen.queryByRole("dialog")).toBeNull(); // already seen this session
  });

  it("Chrome: renders nothing", () => {
    stubBrowser(UA.chromeMac, "Google Inc.");
    render(<BrowserSupportNotice />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Firefox: renders nothing", () => {
    stubBrowser(UA.firefoxWin, "");
    render(<BrowserSupportNotice />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
