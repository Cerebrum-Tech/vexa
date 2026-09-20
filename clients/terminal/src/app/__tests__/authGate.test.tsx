/** AuthGate — the sign-in page's shape and method switch. With LDAP configured the page is the
 *  domain form (heading naming the service, label-over-field inputs, one pill, a note under it) and
 *  links nowhere; the other methods open only through `?auth=email` and link back. Without LDAP the
 *  other methods are the page. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

import { AuthGate } from "../AuthGate";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function stubProbes(opts: { ldap: boolean; providers?: Record<string, unknown>; adminExists?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/auth/me")) return new Response(null, { status: 401 });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (u.includes("/api/auth/providers")) return json(opts.providers ?? {});
      if (u.includes("/api/auth/instance")) return json({ admin_exists: opts.adminExists ?? true });
      if (u.includes("/api/auth/ldap")) return json({ enabled: opts.ldap });
      return new Response(null, { status: 404 });
    }),
  );
}

describe("AuthGate", () => {
  it("LDAP deploy: heading, label-over-field inputs, pill, the note, and no method link", async () => {
    stubProbes({ ldap: true });
    render(<AuthGate><div data-testid="workbench" /></AuthGate>);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("İnnova Toplantı Asistanı'na giriş yapın"));
    expect(screen.queryByTestId("workbench")).toBeNull();
    expect(screen.getByLabelText("Kullanıcı Adı").getAttribute("placeholder")).toBe("Kullanıcı adınızı girin");
    expect(screen.getByLabelText("Şifre").getAttribute("placeholder")).toBe("Şifrenizi girin");
    expect(screen.getByRole("button", { name: "Giriş yap" }).getAttribute("disabled")).not.toBeNull();
    expect(screen.getByText("* İnnova kullanıcınız ile giriş yapın")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "E-posta ile devam et" })).toBeNull();
    expect(screen.queryByText(/LDAP/)).toBeNull();
    // the old card chrome is gone
    expect(screen.queryByAltText("Innova")).toBeNull();
    expect(screen.queryByText("Diğer giriş seçenekleri")).toBeNull();
  });

  it("the eye toggles the password field between hidden and shown", async () => {
    stubProbes({ ldap: true });
    render(<AuthGate><div /></AuthGate>);
    const pass = await screen.findByLabelText("Şifre");
    expect(pass.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Şifreyi göster" }));
    expect(pass.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Şifreyi gizle" }));
    expect(pass.getAttribute("type")).toBe("password");
  });

  it("?auth=email opens the other methods; their link leads back to LDAP", async () => {
    window.history.replaceState({}, "", "/?auth=email");
    stubProbes({ ldap: true, providers: { google: {} } });
    render(<AuthGate><div /></AuthGate>);
    expect(await screen.findByRole("button", { name: /Google ile devam et/ })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("İnnova Toplantı Asistanı'na giriş yapın");
    expect(screen.queryByLabelText("Kullanıcı Adı")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "LDAP ile devam et" }));
    expect(screen.getByLabelText("Kullanıcı Adı")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "E-posta ile devam et" })).toBeNull();
  });

  it("no LDAP and no OAuth: the e-posta form is the page, with no method link", async () => {
    stubProbes({ ldap: false });
    render(<AuthGate><div /></AuthGate>);
    await waitFor(() => expect(screen.getByLabelText(/E-posta/)).toBeTruthy());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("İnnova Toplantı Asistanı'na giriş yapın");
    expect(screen.getByRole("button", { name: "Giriş yap" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "LDAP ile devam et" })).toBeNull();
    expect(screen.queryByRole("button", { name: "E-posta ile devam et" })).toBeNull();
  });

  it("fresh instance: the claim heading and the one-time note", async () => {
    stubProbes({ ldap: true, adminExists: false });
    render(<AuthGate><div /></AuthGate>);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("İnnova Toplantı Asistanı kurulumunu sahiplenin"));
    expect(screen.getByRole("button", { name: "Yönetici olarak giriş yap" })).toBeTruthy();
    expect(screen.getByText("Bu ekran, bir yönetici belirlendikten sonra bir daha görünmez.")).toBeTruthy();
  });
});
