/** AuthGate — the İnnova sign-in card's shape and method switch. With LDAP configured the card is
 *  the domain form (app name, "Hoş geldiniz", Kullanıcı adı + Şifre with an eye, the red "Giriş yap"
 *  button, the note) under the "Diğer giriş seçenekleri" link; the other methods also open through
 *  `?auth=email` and link back. Without LDAP the other methods are the card. */
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
  it("LDAP deploy: the İnnova header, the card's heading and fields, the red button, the note, and the other-options link", async () => {
    stubProbes({ ldap: true });
    render(<AuthGate><div data-testid="workbench" /></AuthGate>);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hoş geldiniz"));
    expect(screen.queryByTestId("workbench")).toBeNull();
    // header: the white wordmark on its charcoal backing, next to the suite label
    expect(screen.getByAltText("İnnova").getAttribute("src")).toBe("/innova-logo-beyaz.svg");
    expect(screen.getAllByText("Kurumsal uygulamalar").length).toBeGreaterThan(0);
    expect(screen.getByText("Toplantı Asistanı")).toBeTruthy();
    expect(screen.getByText("Devam etmek için hesabınıza giriş yapın.")).toBeTruthy();
    const user = screen.getByLabelText("Kullanıcı adı");
    expect(user.getAttribute("placeholder")).toBe("Kullanıcı adınızı girin");
    expect(user.getAttribute("autocomplete")).toBe("username");
    expect(user.hasAttribute("autofocus")).toBe(false);
    const pass = screen.getByLabelText("Şifre");
    expect(pass.getAttribute("placeholder")).toBe("Şifrenizi girin");
    expect(pass.getAttribute("autocomplete")).toBe("current-password");
    // the primary button is enabled (red) from the start; `required` gates empty submits
    const submit = screen.getByRole("button", { name: "Giriş yap" });
    expect(submit.getAttribute("disabled")).toBeNull();
    expect(submit.className).toBe("il-submit");
    expect(screen.getByText("İnnova kullanıcı bilgilerinizle giriş yapın.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "E-posta ile devam et" })).toBeNull();
    expect(screen.queryByText(/LDAP/)).toBeNull();
    expect(screen.getByRole("button", { name: "Diğer giriş seçenekleri" })).toBeTruthy();
    expect(document.querySelector(".innova-login .il-card")).toBeTruthy();
  });

  it("rejected credentials land in the alert region and the button comes back", async () => {
    stubProbes({ ldap: true });
    // the POST hangs until the test releases it, so the pending state is observable
    let reject!: () => void;
    const pending = new Promise<Response>((resolve) => { reject = () => resolve(new Response(JSON.stringify({ error: "Kullanıcı adı veya şifre hatalı" }), { status: 401 })); });
    const fetchMock = vi.mocked(globalThis.fetch as unknown as ReturnType<typeof vi.fn>);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/auth/me")) return new Response(null, { status: 401 });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (u.includes("/api/auth/providers")) return json({});
      if (u.includes("/api/auth/instance")) return json({ admin_exists: true });
      if (u.includes("/api/auth/ldap") && init?.method === "POST") return pending;
      if (u.includes("/api/auth/ldap")) return json({ enabled: true });
      return new Response(null, { status: 404 });
    });
    render(<AuthGate><div /></AuthGate>);
    fireEvent.change(await screen.findByLabelText("Kullanıcı adı"), { target: { value: "ayse" } });
    fireEvent.change(screen.getByLabelText("Şifre"), { target: { value: "hunter2" } });
    fireEvent.submit(screen.getByRole("button", { name: "Giriş yap" }).closest("form")!);
    const busy = await screen.findByRole("button", { name: "Giriş yapılıyor…" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("disabled")).not.toBeNull();
    // a second submit while pending sends nothing more
    fireEvent.submit(busy.closest("form")!);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
    reject();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Kullanıcı adı veya şifre hatalı");
    expect(alert.className).toBe("il-error");
    const submit = screen.getByRole("button", { name: "Giriş yap" });
    expect(submit.getAttribute("disabled")).toBeNull();
    expect(submit.getAttribute("aria-busy")).toBeNull();
    // the password is never kept after an attempt; nothing is marked field-invalid for a server reject
    expect((screen.getByLabelText("Şifre") as HTMLInputElement).value).toBe("");
    expect(document.querySelector("[aria-invalid=true]")).toBeNull();
  });

  it("the other-options link swaps LDAP for the other methods and back", async () => {
    stubProbes({ ldap: true, providers: { google: {} } });
    render(<AuthGate><div /></AuthGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Diğer giriş seçenekleri" }));
    expect(screen.getByRole("button", { name: /Google ile devam et/ })).toBeTruthy();
    expect(screen.queryByLabelText("Kullanıcı adı")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "LDAP ile devam et" }));
    expect(screen.getByLabelText("Kullanıcı adı")).toBeTruthy();
  });

  it("the eye toggles the password field between hidden and shown, keeping the value", async () => {
    stubProbes({ ldap: true });
    render(<AuthGate><div /></AuthGate>);
    const pass = (await screen.findByLabelText("Şifre")) as HTMLInputElement;
    fireEvent.change(pass, { target: { value: "hunter2" } });
    expect(pass.getAttribute("type")).toBe("password");
    const eye = screen.getByRole("button", { name: "Şifreyi göster" });
    expect(eye.getAttribute("type")).toBe("button");
    expect(eye.getAttribute("aria-controls")).toBe(pass.id);
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(eye);
    expect(pass.getAttribute("type")).toBe("text");
    expect(pass.value).toBe("hunter2");
    const eyeOn = screen.getByRole("button", { name: "Şifreyi gizle" });
    expect(eyeOn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(eyeOn);
    expect(pass.getAttribute("type")).toBe("password");
  });

  it("?auth=email opens the other methods; their link leads back to LDAP", async () => {
    window.history.replaceState({}, "", "/?auth=email");
    stubProbes({ ldap: true, providers: { google: {} } });
    render(<AuthGate><div /></AuthGate>);
    expect(await screen.findByRole("button", { name: /Google ile devam et/ })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hoş geldiniz");
    expect(screen.queryByLabelText("Kullanıcı adı")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "LDAP ile devam et" }));
    expect(screen.getByLabelText("Kullanıcı adı")).toBeTruthy();
  });

  it("no LDAP and no OAuth: the e-posta form is the page, with no method link", async () => {
    stubProbes({ ldap: false });
    render(<AuthGate><div /></AuthGate>);
    await waitFor(() => expect(screen.getByLabelText(/E-posta/)).toBeTruthy());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hoş geldiniz");
    expect(screen.getByRole("button", { name: "Giriş yap" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "LDAP ile devam et" })).toBeNull();
    expect(screen.queryByRole("button", { name: "E-posta ile devam et" })).toBeNull();
  });

  it("fresh instance: the claim heading and the one-time note", async () => {
    stubProbes({ ldap: true, adminExists: false });
    render(<AuthGate><div /></AuthGate>);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Kurulumu sahiplenin"));
    expect(screen.getByText(/İlk giriş yapan kişi yönetici olur/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yönetici olarak giriş yap" })).toBeTruthy();
    expect(screen.getByText("Bu ekran, bir yönetici belirlendikten sonra bir daha görünmez.")).toBeTruthy();
  });
});
