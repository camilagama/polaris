import type { BillingPlanView } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  canCancelRenewal,
  cancelDialogText,
  cancelHint,
  cancelledGraceText,
  cancelledText,
  commandRefusal,
  FREE_CHANGES,
  keptText,
  overdueText,
  reasonOf,
  refundDialogText,
  refundHint,
  refundRequestedText,
  safeOverduePaymentUrl,
  supportRefundText,
  unsafeOverdueRefusal,
} from "./subscription-commands-model";

function plan(overrides: Partial<BillingPlanView> = {}): BillingPlanView {
  return {
    accessEndsAt: "2026-11-24T03:00:00.000Z",
    cycleMonths: 1,
    kept: { historyMonths: 3, products: 18, sales: 47 },
    limits: { goals: 3, images: 5000, variants: 2000 },
    method: "card",
    nextCharge: { amount: "24.90", on: "2026-11-23" },
    offer: { methods: ["card"], prices: [] },
    recovery: null,
    refund: null,
    refundPending: false,
    refundWindowEndedOn: null,
    renewalCancelled: false,
    resubscribeFrom: null,
    state: "active",
    trialAvailable: false,
    usage: { goals: 1, images: 12, variants: 38 },
    ...overrides,
  };
}

const A_DATE = /\d{2}\/\d{2}/;
const A_DIGIT = /\d/;
const A_DEADLINE = /dias? úte|prazo/;
const AN_ANSWER_TIME = /respondemos|útil/i;
const A_FAILURE = /Nada foi|falhou/;

/** The contract's rule for the reason (`billingCancelRenewalInput`). */
const CONTRACT_REASON = /^(?:[^\p{C}]|[\n\t])*$/u;

/** The window of a first charge on `23/10/2026`: it ends at 23:59:59 of `30/10` in São Paulo (02:59:59Z on `31/10`). */
const UNTIL = "2026-10-31T02:59:59.999Z";
const REFUND = { amount: "24.90", until: UNTIL, via: "app" as const };
const RPC_ERROR = (code: string, reason: string) => ({
  code,
  data: { reason },
  status: 409,
});

describe("cancel the renewal (AC-21 to AC-28)", () => {
  it("is offered in trial, active and grace, and not once cancelled nor outside the Pro", () => {
    expect(canCancelRenewal(plan({ state: "trialing" }))).toBe(true);
    expect(canCancelRenewal(plan())).toBe(true);
    expect(canCancelRenewal(plan({ state: "grace" }))).toBe(true);
    expect(canCancelRenewal(plan({ renewalCancelled: true }))).toBe(false);
    for (const state of ["free", "free_over_limit", "trial_setup"] as const) {
      expect(canCancelRenewal(plan({ state }))).toBe(false);
    }
  });

  it("the dialog says the last day paid for and that the store goes to the Free", () => {
    expect(cancelDialogText(plan())).toEqual({
      confirm: "Cancelar a renovação",
      description:
        "Seu Pro continua até 23/11/2026, o fim do que você já pagou. Depois dessa data a loja volta ao plano Free.",
      title: "Cancelar a renovação do Pro?",
    });
  });

  it("in trial: nothing is charged, no other trial, and no date of the access (AC-25, item 13)", () => {
    const text = cancelDialogText(plan({ state: "trialing" }));
    expect(text.description).toBe(
      "O teste vai até o fim e nada é cobrado. Você não terá outro teste grátis. Depois a loja volta ao plano Free."
    );
    expect(text.description).not.toMatch(A_DATE);
    // nothing renews in a trial: the button repeats the title, not "a renovação"
    expect(text.confirm).toBe("Cancelar o Pro");
    expect(cancelHint(plan({ state: "trialing" }))).toBe(
      "O teste vai até o fim e nada é cobrado. Você não terá outro teste grátis."
    );
  });

  it("in grace: no new attempt, and the Pro until the end of the grace (AC-28)", () => {
    const grace = plan({
      accessEndsAt: "2026-10-31T03:00:00.000Z",
      state: "grace",
    });
    expect(cancelDialogText(grace).description).toBe(
      "Não há nova tentativa de cobrança. Seu Pro continua até 30/10/2026. Depois dessa data a loja volta ao plano Free."
    );
    expect(cancelHint(grace)).toBe("Seu Pro continua até 30/10/2026.");
  });

  it("what changes on the Free has no number: the Free's limits are the catalog's (AC-23)", () => {
    expect(FREE_CHANGES).toHaveLength(5);
    for (const line of FREE_CHANGES) {
      expect(line).not.toMatch(A_DIGIT);
    }
  });

  it("what stays: the store's numbers, or only that the data stays (AC-24)", () => {
    expect(keptText(plan())).toBe(
      "47 vendas, 18 produtos e 3 meses de histórico. Seus dados não são apagados."
    );
    expect(
      keptText(plan({ kept: { historyMonths: 0, products: 0, sales: 0 } }))
    ).toBe("Seus dados não são apagados.");
  });

  it("the reason: trimmed, empty is none, never past 500 (AC-29)", () => {
    expect(reasonOf("   ")).toBeUndefined();
    expect(reasonOf("  caro  ")).toBe("caro");
    expect(reasonOf("x".repeat(600))).toHaveLength(500);
  });

  it("the reason loses what the contract refuses, keeps line breaks, and is never cut inside a character", () => {
    expect(reasonOf("👩\u200d💻 caro")).toBe("👩💻 caro");
    expect(reasonOf("a\u200eb\u202ec")).toBe("abc");
    expect(reasonOf("linha 1\nlinha 2\tfim")).toBe("linha 1\nlinha 2\tfim");
    expect(reasonOf("a\ud800b")).toBe("ab");
    const cut = reasonOf(`${"x".repeat(499)}😀`);
    expect(cut).toBe("x".repeat(499));
    expect(reasonOf("ok \u0007 \u2066x\u2069 \ufeff")).toMatch(CONTRACT_REASON);
  });

  it("the result says until when the Pro goes, cancelled now or already", () => {
    expect(cancelledText("cancelled", "2026-11-24T03:00:00.000Z")).toBe(
      "Renovação cancelada. Seu Pro continua até 23/11/2026 e nada mais é cobrado."
    );
    expect(cancelledText("already_cancelled", null)).toBe(
      "A renovação já estava cancelada. Nada mais é cobrado."
    );
  });
});

describe("the right of withdrawal (AC-30, AC-34, AC-42, AC-44)", () => {
  it("the button's line: until the last minute, the amount, and that the Pro ends now", () => {
    expect(refundHint(REFUND)).toBe(
      "Vale até 30/10/2026, 23:59. Devolvemos R$ 24,90 e o Pro termina na hora."
    );
  });

  it("the dialog: the amount and the effect, with no promise of when the money arrives (AC-34)", () => {
    const text = refundDialogText("24.90");
    expect(text.description).toBe(
      "Você recebe R$ 24,90 de volta e o Pro acaba agora. Seus dados ficam."
    );
    expect(text.description).not.toMatch(A_DEADLINE);
  });

  it("Pix by support: the day, the box of the configuration, what counts and no personal data (AC-44)", () => {
    const text = supportRefundText(
      { ...REFUND, via: "suporte" },
      "caixa@exemplo.test"
    );
    expect(text).toContain("escreva para caixa@exemplo.test");
    expect(text).toContain("até 30/10/2026, 23:59");
    expect(text).toContain("com o nome da loja");
    expect(text).toContain(
      "O pedido enviado até essa data vale, mesmo que a resposta chegue depois."
    );
    expect(text).toContain("Não mande CPF, CNPJ nem dados de pagamento.");
    // no answer time is promised (AC-44 d)
    expect(text).not.toMatch(AN_ANSWER_TIME);
  });

  it("Pix by support without the box: no address made up", () => {
    const text = supportRefundText({ ...REFUND, via: "suporte" }, null);
    expect(text).toContain(
      "escreva para o suporte do Polaris (o endereço está no fim dos e-mails da sua assinatura)"
    );
    expect(text).not.toContain("@");
  });

  it("the card's refund taken: asked, and confirmed only once the plan read again left the Pro (AS-34)", () => {
    const pending = plan({ refundPending: true, renewalCancelled: true });
    expect(refundRequestedText("24.90", pending)).toBe(
      "Pedimos o reembolso de R$ 24,90. Quando ele for confirmado, o Pro acaba e a loja volta ao Free. Seus dados ficam."
    );
    expect(refundRequestedText("24.90", plan({ state: "free" }))).toBe(
      "Reembolso confirmado: você recebe R$ 24,90 de volta e o Pro acabou. Seus dados ficam."
    );
  });
});

describe("pay the charge that failed (AC-43)", () => {
  it("a renewal already cancelled in grace says only that the charge will not be paid", () => {
    expect(cancelledGraceText()).toBe(
      "Renovação cancelada. A cobrança pendente não será paga."
    );
  });

  it("says it pays the charge that failed and does not change the card", () => {
    expect(
      overdueText(
        plan({ accessEndsAt: "2026-10-31T03:00:00.000Z", state: "grace" })
      )
    ).toBe(
      "Isto paga a cobrança que falhou. A próxima renovação ainda tenta o cartão cadastrado. Para usar outro cartão, cancele a renovação e assine de novo depois de 30/10/2026."
    );
  });

  it.each([
    "https://www.asaas.com/i/abc",
    "https://asaas.com/i/abc",
    "https://sandbox.asaas.com/i/abc",
  ])("opens the exact host %s", (url) => {
    expect(safeOverduePaymentUrl(url)).toBe(url);
  });

  it.each([
    ["a host that only ends like Asaas's", "https://asaas.com.evil/i/abc"],
    ["a host that only contains it", "https://evilasaas.com/i/abc"],
    ["a subdomain of its", "https://pay.asaas.com/i/abc"],
    ["http", "http://www.asaas.com/i/abc"],
    ["a port", "https://www.asaas.com:8443/i/abc"],
    ["credentials", "https://user@www.asaas.com/i/abc"],
    [
      "credentials with the host as the user",
      "https://www.asaas.com@evil.test/",
    ],
    ["javascript", "javascript:alert(1)"],
    ["not an address", "asaas.com"],
  ])("refuses %s", (_label, url) => {
    expect(safeOverduePaymentUrl(url)).toBeNull();
  });
});

describe("commandRefusal: each reason its own text (AS-17)", () => {
  it("the provider down: AC-26 on cancel, nothing cancelled; try again", () => {
    expect(
      commandRefusal(
        "cancel",
        RPC_ERROR("SERVICE_UNAVAILABLE", "billing_provider_unavailable")
      )
    ).toEqual({
      reread: false,
      retry: true,
      text: "Não conseguimos cancelar agora. Nada foi cancelado e nada foi cobrado a mais. Tente de novo.",
    });
    // never "Nada foi cancelado" on the refund: on a repeat the renewal is already cancelled (AS-42)
    expect(
      commandRefusal(
        "refund",
        RPC_ERROR("SERVICE_UNAVAILABLE", "billing_provider_unavailable")
      ).text
    ).toBe(
      "Não conseguimos pedir o reembolso agora. Nada foi cobrado a mais. Tente de novo."
    );
    expect(
      commandRefusal(
        "overdue",
        RPC_ERROR("SERVICE_UNAVAILABLE", "billing_provider_unavailable")
      ).text
    ).toContain("página de pagamento");
  });

  it.each([
    ["command_in_progress", "Já tem um pedido em andamento"],
    ["billing_command_rate_limited", "Muitas tentativas seguidas"],
    ["billing_audit_unavailable", "Não conseguimos confirmar o pedido"],
  ])("%s may be tried again", (reason, text) => {
    const refusal = commandRefusal("cancel", RPC_ERROR("CONFLICT", reason));
    expect(refusal.retry).toBe(true);
    expect(refusal.reread).toBe(false);
    expect(refusal.text).toContain(text);
  });

  it("the audit lost does not say the act failed (it was done)", () => {
    expect(
      commandRefusal(
        "refund",
        RPC_ERROR("SERVICE_UNAVAILABLE", "billing_audit_unavailable")
      ).text
    ).not.toMatch(A_FAILURE);
  });

  it.each([
    ["cancel", "nothing_to_cancel", "Não há renovação para cancelar"],
    ["refund", "nothing_to_refund", "Não há valor a reembolsar"],
    ["refund", "refund_via_support", "pedido ao suporte"],
    ["refund", "refund_window_expired", "O nosso suporte conclui"],
    ["overdue", "no_overdue_payment", "Não há cobrança pendente"],
  ] as const)(
    "%s %s: the plan changed, 'Atualizar'",
    (command, reason, text) => {
      const refusal = commandRefusal(command, RPC_ERROR("CONFLICT", reason));
      expect(refusal).toMatchObject({ reread: true, retry: false });
      expect(refusal.text).toContain(text);
    }
  );

  it("a reason the contract refuses keeps the dialog, with what was typed", () => {
    expect(
      commandRefusal("cancel", { code: "BAD_REQUEST", status: 400 })
    ).toMatchObject({ reread: false, retry: true });
  });

  it("an address out of the exact hosts is said as the provider's failure", () => {
    expect(unsafeOverdueRefusal()).toEqual(
      commandRefusal(
        "overdue",
        RPC_ERROR("SERVICE_UNAVAILABLE", "billing_provider_unavailable")
      )
    );
  });

  it("without the capability or the flag, nothing to try", () => {
    expect(
      commandRefusal("cancel", {
        code: "FORBIDDEN",
        data: { reason: "billing_manage_required" },
      })
    ).toMatchObject({ reread: false, retry: false });
    expect(
      commandRefusal("cancel", {
        code: "NOT_FOUND",
        data: { reason: "billing_self_service_off" },
      })
    ).toMatchObject({ reread: false, retry: false });
  });

  it("the connection cut: try again, the same request is not done twice", () => {
    expect(commandRefusal("cancel", new TypeError("Failed to fetch"))).toEqual(
      expect.objectContaining({ retry: true })
    );
  });
});
