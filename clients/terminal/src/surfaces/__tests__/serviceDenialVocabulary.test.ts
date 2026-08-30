/** The denial-reason vocabulary, pinned — TERMINAL twin.
 *
 *  `core/meetings/contracts/service-authority.v1` (this repo) is SEALED and types
 *  `Decision.reason` as an OPAQUE `{"type":"string","minLength":1}` — by design, since that
 *  contract is deliberately policy-free. Nothing on the wire constrains the set, and the set is now
 *  consumed by THREE copy modules across TWO repositories:
 *
 *    1. Vexa-ai/vexa           clients/terminal/src/surfaces/serviceDenial.ts        (this one)
 *    2. Vexa-ai/vexa           services/dashboard/src/lib/service-denial.ts
 *    3. Vexa-ai/vexa-platform  services/webapp/apps/webapp/lib/service-denial-view.ts
 *
 *  Three hand-maintained copies with nothing checking them against each other is the silent-drift
 *  class: a reason added in the authority renders here as a raw "service not allowed: <code>",
 *  which is the customer-visible failure that opened Vexa-ai/vexa-platform#291.
 *
 *  This file is the terminal's pin. Its twins — which carry the same literal — are
 *  `services/dashboard/tests/service-denial-vocabulary.test.ts` (this repo) and
 *  `services/webapp/apps/webapp/__tests__/service-authority-reason-vocabulary.test.ts` (platform),
 *  the latter additionally deriving the set from `ServiceAuthorityReason` and `decisionReason()` at
 *  their source. Change one, change all six places named below.
 *
 *  NOTE FOR THE MERGER: the two older pins' failure messages still name only FOUR places, because
 *  they predate this module. Reconcile all three message lists at merge time.
 *
 *  What is shared across the six places is the REASON SET and the kind/action mapping — not the
 *  words. This deployment ships a Turkish terminal, so the copy pinned below is Turkish while the
 *  dashboard and webapp twins stay English; the sentences are pinned here because a customer
 *  screenshots them, not because they are byte-identical to another surface.
 *
 *  Narrowing `reason` to an enum in the contract is the deeper fix, and it is a BREAKING change to
 *  a frozen `.vN`: it needs a `service-authority.v2` on a `lane:contract` human-reviewed PR
 *  (gate:contract-version), not an edit to v1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../apiClient";
import {
  SERVICE_DENIAL_REASONS,
  isAccessError,
  resolveJoinError,
  serviceDenialPresentation,
} from "../serviceDenial";

const PINNED_REASON_VOCABULARY = [
  "allowed",
  "billing_setup_required",
  "insufficient_balance",
  "payment_past_due",
  "spend_cap_reached",
  "concurrency_limit_reached",
  "billing_unavailable",
] as const;

const CROSS_REPO_FIXUP = [
  "The denial-reason vocabulary changed. Update ALL of:",
  "  1. this pin (Vexa-ai/vexa clients/terminal/src/surfaces/__tests__/serviceDenialVocabulary.test.ts)",
  "  2. Vexa-ai/vexa clients/terminal/src/surfaces/serviceDenial.ts (the terminal copy module)",
  "  3. Vexa-ai/vexa services/dashboard/src/lib/service-denial.ts (the dashboard copy module)",
  "  4. Vexa-ai/vexa services/dashboard/tests/service-denial-vocabulary.test.ts (the dashboard pin)",
  "  5. Vexa-ai/vexa-platform services/webapp/apps/webapp/lib/service-denial-view.ts (the webapp copy module)",
  "  6. Vexa-ai/vexa-platform services/webapp/apps/webapp/__tests__/service-authority-reason-vocabulary.test.ts (the webapp pin)",
  "A reason with copy on only one surface reaches customers as a raw code.",
].join("\n");

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

const denial = (status: number, reason: string) =>
  new ApiError(status, `{"code":"service_not_allowed","reason":"${reason}"}`, "/api/bots", {
    detail: { code: "service_not_allowed", reason, decision_id: "d-1" },
  });

describe("service-authority denial-reason vocabulary (Vexa-ai/vexa-platform#291)", () => {
  it("maps exactly the pinned vocabulary — no more, no less", () => {
    expect(sorted(SERVICE_DENIAL_REASONS), CROSS_REPO_FIXUP).toEqual(
      sorted(PINNED_REASON_VOCABULARY),
    );
  });

  it("gives every pinned reason real copy, never the verbatim fallback", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const reason of PINNED_REASON_VOCABULARY) {
        const view = serviceDenialPresentation(reason);
        expect(view.body, `${reason}\n${CROSS_REPO_FIXUP}`).not.toContain(
          `Hizmet izni verilmedi: ${reason}. Bu durum tekrarlanırsa`,
        );
        // Never flattened into the generic 403 line the presenter seam would otherwise give
        // ("Anahtarınızın buna erişim yetkisi yok." — apiClient.presentError).
        expect(view.body).not.toMatch(/erişim yetkisi yok/i);
        expect(view.title.length).toBeGreaterThan(0);
      }
      // Not one of them fell through to the unmapped branch.
      expect(consoleError, CROSS_REPO_FIXUP).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps 'allowed' out of the denial-styled kinds", () => {
    // `allowed` is in the vocabulary because the authority emits it, but it is not a denial: a
    // caller reaching the view with it has mismatched allow/reason and must not be shown a paywall.
    expect(serviceDenialPresentation("allowed").kind).toBe("unknown");
    expect(serviceDenialPresentation("allowed").action).toBeNull();
  });

  it("pins the two sentences a customer is most likely to screenshot at us", () => {
    // The `kind`/`action` mapping is the cross-surface contract; the words are this terminal's
    // Turkish. Both are pinned, so neither a retitled panel nor a re-kinded reason lands silently.
    expect(serviceDenialPresentation("insufficient_balance")).toMatchObject({
      kind: "paywall",
      title: "Bakiyeniz tükendi",
      body:
        "Ön ödemeli bakiyeniz boş. Bakiye yüklediğinizde bot toplantıya " +
        "hemen katılır — hesabınızda başka hiçbir şeyi değiştirmeniz gerekmez.",
      action: { label: "Bakiye yükle", href: "/account?tab=bots" },
    });
    expect(serviceDenialPresentation("billing_unavailable")).toMatchObject({
      kind: "retryable",
      title: "Faturalandırma sistemi geçici olarak kullanılamıyor",
      body:
        "Hesabınızda bir sorun yok — şu anda faturalandırma kayıtlarına " +
        "ulaşamadık. Lütfen kısa bir süre sonra yeniden deneyin.",
      retryable: true,
    });
  });

  it("puts the caller's numbers in the copy when it has them", () => {
    expect(serviceDenialPresentation("insufficient_balance", {
      balanceCents: 250, planLabel: "Pay-as-you-go",
    }).body).toContain("Pay-as-you-go planındaki ön ödemeli bakiyeniz $2.50.");
    // Turkish keeps the counted noun singular ("1 bot", "3 bot"), so the pair pins the ceiling
    // reaching the copy, not an English plural rule.
    expect(serviceDenialPresentation("concurrency_limit_reached", {
      concurrencyCeiling: 1,
    }).body).toContain("Planınız aynı anda 1 bot çalıştırıyor");
    expect(serviceDenialPresentation("concurrency_limit_reached", {
      concurrencyCeiling: 3,
    }).body).toContain("Planınız aynı anda 3 bot çalıştırıyor");
  });
});

describe("access failures are never dressed as a paywall", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("renders a 401 as an access error, not a denial panel", () => {
    const error = new ApiError(401, "Invalid API token", "/api/bots", { detail: "Invalid API token" });
    expect(resolveJoinError(error).kind).toBe("message");
    expect(isAccessError(error)).toBe(true);
  });

  it("renders a genuine permission 403 as an access error, not a paywall", () => {
    // A real permission fault: 403, but no `service_not_allowed` code in the body. Routing this to
    // the paywall would tell a customer to pay for a problem money cannot fix.
    const error = new ApiError(403, "Not authorized to access this meeting", "/api/bots", {
      detail: "Not authorized to access this meeting",
    });
    const state = resolveJoinError(error);
    expect(state.kind).toBe("message");
    if (state.kind !== "message") throw new Error("unreachable");
    expect(state.headline).not.toMatch(/bakiye|kredi|fatura|ödeme|credit|balance|billing|payment/i);
    expect(isAccessError(error)).toBe(true);
  });

  it("does not confuse a 401 that happens to carry a denial-shaped body", () => {
    // Defence in depth: the 401 branch short-circuits before body sniffing, so an expired token can
    // never be presented as a billing problem.
    const error = denial(401, "insufficient_balance");
    expect(resolveJoinError(error).kind).toBe("message");
    expect(isAccessError(error)).toBe(true);
  });

  it("still routes a real 403 denial to the paywall panel", () => {
    // The positive control for the three negatives above, and the regression this PR exists for:
    // before it, this error rendered as "Anahtarınızın buna erişim yetkisi yok."
    const error = denial(403, "insufficient_balance");
    const state = resolveJoinError(error);
    expect(state.kind).toBe("denial");
    if (state.kind !== "denial") throw new Error("unreachable");
    expect(state.presentation.kind).toBe("paywall");
    expect(state.presentation.title).toBe("Bakiyeniz tükendi");
    expect(isAccessError(error)).toBe(false);
  });

  it("routes the 503 authority outage to a retryable panel, not a paywall", () => {
    const error = new ApiError(503, "", "/api/bots", {
      detail: { code: "service_authority_unavailable", reason: "service_authority_unavailable" },
    });
    const state = resolveJoinError(error);
    expect(state.kind).toBe("denial");
    if (state.kind !== "denial") throw new Error("unreachable");
    expect(state.presentation.kind).toBe("retryable");
    expect(state.presentation.retryable).toBe(true);
    expect(state.presentation.action).toBeNull();
  });

  it("recovers a denial whose body only survived as the flattened detail string", () => {
    // `ApiError.detail` is the operator string. A call site built before `ApiError.body` existed
    // still produces a transparent panel rather than "Anahtarınızın buna erişim yetkisi yok."
    const error = new ApiError(
      403,
      '{"code":"service_not_allowed","reason":"payment_past_due"}',
      "/api/bots",
    );
    const state = resolveJoinError(error);
    expect(state.kind).toBe("denial");
    if (state.kind !== "denial") throw new Error("unreachable");
    expect(state.presentation.title).toBe("Ödemeniz gecikti");
  });

  it("logs an unmapped reason in a production build so the net can see it", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const state = resolveJoinError(denial(403, "region_unsupported"));
      expect(state.kind).toBe("denial");
      if (state.kind !== "denial") throw new Error("unreachable");
      // The raw code stays verbatim in front of the customer — never flattened away. Only the
      // sentence around it is Turkish; the logged line below stays English (operator channel).
      expect(state.presentation.kind).toBe("unknown");
      expect(state.presentation.body).toContain("Hizmet izni verilmedi: region_unsupported");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("unmapped service-authority reason: region_unsupported"),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
