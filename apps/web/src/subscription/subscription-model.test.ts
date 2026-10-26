import type { BillingPlanView } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  accessDateText,
  clearPlanNotice,
  daysUntil,
  graceNotice,
  legacyCheckoutReturnPath,
  PLAN_NOTICE_FOR_MS,
  PLAN_NOTICE_KEY,
  planNoticeIsOld,
  planNoticeRetryDelayMs,
  rememberedPlanNotice,
  rememberPlanNotice,
  untilText,
} from "./plan-notice";
import {
  abandonedCheckoutText,
  checkoutRefusal,
  checkoutReturnOf,
  defaultCycle,
  firstChargeDay,
  keptLine,
  offerCycles,
  offerTerms,
  paymentLines,
  planHeadline,
  readRefusal,
  REFUND_RULE,
  refundPendingNotice,
  refundRuleLine,
  safeProviderUrl,
  usageRows,
  waitsForProvider,
} from "./subscription-model";

function plan(overrides: Partial<BillingPlanView> = {}): BillingPlanView {
  return {
    accessEndsAt: null,
    cycleMonths: null,
    kept: { historyMonths: 3, products: 18, sales: 47 },
    limits: { goals: 1, images: 30, variants: 50 },
    method: null,
    nextCharge: null,
    offer: {
      methods: ["card", "pix_automatic"],
      prices: [
        { amount: "24.90", cycleMonths: 1 },
        { amount: "249.00", cycleMonths: 12 },
      ],
    },
    recovery: null,
    refund: null,
    refundPending: false,
    refundWindowEndedOn: null,
    renewalCancelled: false,
    resubscribeFrom: null,
    state: "free",
    trialAvailable: true,
    usage: { goals: 1, images: 12, variants: 38 },
    ...overrides,
  } as BillingPlanView;
}

const NOW = new Date("2026-10-23T15:00:00Z");

function rpcError(
  code: string,
  reason: string,
  extra: { message?: string; until?: string } = {}
) {
  const { message = "", until } = extra;
  return {
    code,
    data: until === undefined ? { reason } : { reason, until },
    message,
  };
}

describe("planHeadline", () => {
  it("says Free with the variants in use", () => {
    expect(planHeadline(plan(), NOW)).toEqual({
      badge: null,
      support: "Você usa 38 de 50 variantes.",
      title: "Plano Free",
    });
  });

  it("has no support line when variants are unlimited", () => {
    const view = plan({ limits: { goals: 1, images: 30, variants: null } });
    expect(planHeadline(view, NOW).support).toBeNull();
  });

  it("flags Free over the limit", () => {
    const headline = planHeadline(plan({ state: "free_over_limit" }), NOW);
    expect(headline.title).toBe("Plano Free");
    expect(headline.badge?.text).toBe("acima do limite");
  });

  it("asks to authorize the payment on trial_setup", () => {
    expect(planHeadline(plan({ state: "trial_setup" }), NOW).title).toBe(
      "Falta autorizar o pagamento"
    );
  });

  it("says 7 dias grátis and the first charge for a card trial", () => {
    const headline = planHeadline(
      plan({
        method: "card",
        nextCharge: { amount: "24.90", on: "2026-10-30" },
        state: "trialing",
      }),
      NOW
    );
    expect(headline.badge?.text).toBe("7 dias grátis");
    expect(headline.support).toBe(
      "A primeira cobrança é em 30/10/2026. Cancele antes e nada é cobrado."
    );
  });

  it("never says 7 dias in a Pix trial", () => {
    const headline = planHeadline(
      plan({
        method: "pix_automatic",
        nextCharge: { amount: "24.90", on: "2026-10-30" },
        state: "trialing",
      }),
      NOW
    );
    expect(headline.badge?.text).toBe("teste grátis");
    const all = `${headline.title} ${headline.badge?.text} ${headline.support}`;
    expect(all).not.toContain("7 dias");
  });

  it("says Plano Pro, Ativo and the next charge when active", () => {
    const headline = planHeadline(
      plan({
        method: "card",
        nextCharge: { amount: "24.90", on: "2026-11-23" },
        state: "active",
      }),
      NOW
    );
    expect(headline.title).toBe("Plano Pro");
    expect(headline.badge?.text).toBe("Ativo");
    expect(headline.support).toBe("Próxima cobrança em 23/11/2026, R$ 24,90.");
  });

  it("names the last day of access when the renewal is cancelled", () => {
    const headline = planHeadline(
      plan({
        accessEndsAt: "2026-11-24T03:00:00.000Z",
        renewalCancelled: true,
        state: "active",
      }),
      NOW
    );
    expect(headline.title).toBe("Pro até 23/11/2026");
    expect(headline.badge?.text).toBe("Renovação cancelada");
  });

  it("flags a pending refund after cancelling", () => {
    const headline = planHeadline(
      plan({
        accessEndsAt: "2026-11-24T03:00:00.000Z",
        refundPending: true,
        renewalCancelled: true,
        state: "active",
      }),
      NOW
    );
    expect(headline.badge?.text).toBe("Reembolso pendente");
    expect(headline.title).toBe("Pro até 23/11/2026");
  });

  it("counts the days left in grace", () => {
    const headline = planHeadline(
      plan({ accessEndsAt: "2026-10-31T03:00:00.000Z", state: "grace" }),
      NOW
    );
    expect(headline.title).toBe("Pagamento não confirmado");
    expect(headline.badge?.text).toBe("7 dias");
    expect(headline.support).toBe(
      "Seu Pro vai até 30/10/2026. Depois a loja volta ao Free e seus dados ficam."
    );
  });

  it("says último dia on the last day of grace", () => {
    const headline = planHeadline(
      plan({ accessEndsAt: "2026-10-31T03:00:00.000Z", state: "grace" }),
      new Date("2026-10-30T20:00:00Z")
    );
    expect(headline.badge?.text).toBe("último dia");
  });

  it("never counts negative days after the grace ended", () => {
    const headline = planHeadline(
      plan({ accessEndsAt: "2026-10-31T03:00:00.000Z", state: "grace" }),
      new Date("2026-11-05T15:00:00Z")
    );
    expect(headline.badge?.text).toBe("último dia");
  });
});

describe("graceNotice", () => {
  const grace = (accessEndsAt: string | null) =>
    plan({ accessEndsAt, state: "grace" });

  it("is null outside grace", () => {
    expect(graceNotice(plan({ state: "active" }), NOW)).toBeNull();
    expect(graceNotice(plan(), NOW)).toBeNull();
  });

  it("is null in grace without an end date", () => {
    expect(graceNotice(grace(null), NOW)).toBeNull();
  });

  it("says 7 dias on the first day", () => {
    expect(graceNotice(grace("2026-10-31T03:00:00.000Z"), NOW)).toEqual({
      description:
        "Seu Pro vai até 30/10/2026 (7 dias); depois a loja volta ao Free e seus dados ficam.",
      title: "O último pagamento não foi confirmado.",
    });
  });

  it("says 1 dia the day before the last", () => {
    const notice = graceNotice(
      grace("2026-10-31T03:00:00.000Z"),
      new Date("2026-10-29T15:00:00Z")
    );
    expect(notice?.description).toContain("(1 dia)");
  });

  it("says último dia until the end of the day in Sao Paulo", () => {
    const notice = graceNotice(
      grace("2026-10-31T03:00:00.000Z"),
      new Date("2026-10-31T02:59:00Z")
    );
    expect(notice?.description).toContain("(último dia)");
  });

  it("still counts the previous day at 23:59:59 in Sao Paulo", () => {
    const notice = graceNotice(
      grace("2026-10-31T03:00:00.000Z"),
      new Date("2026-10-30T02:59:59Z")
    );
    expect(notice?.description).toContain("(1 dia)");
  });
});

describe("keptLine", () => {
  it("lists sales, products and months of history", () => {
    expect(keptLine({ historyMonths: 3, products: 18, sales: 47 })).toBe(
      "O que a sua loja já guardou: 47 vendas, 18 produtos e 3 meses de histórico. Seus dados não são apagados."
    );
  });

  it("uses the singular for 1", () => {
    expect(keptLine({ historyMonths: 1, products: 1, sales: 1 })).toBe(
      "O que a sua loja já guardou: 1 venda, 1 produto e 1 mês de histórico. Seus dados não são apagados."
    );
  });

  it("leaves out a part at 0", () => {
    expect(keptLine({ historyMonths: 3, products: 18, sales: 0 })).toBe(
      "O que a sua loja já guardou: 18 produtos e 3 meses de histórico. Seus dados não são apagados."
    );
  });

  it("has no connector with a single part", () => {
    const line = keptLine({ historyMonths: 0, products: 0, sales: 5 });
    expect(line).toBe(
      "O que a sua loja já guardou: 5 vendas. Seus dados não são apagados."
    );
    expect(line).not.toContain(" e ");
  });

  it("is null when all three are 0", () => {
    expect(keptLine({ historyMonths: 0, products: 0, sales: 0 })).toBeNull();
  });
});

describe("refundPendingNotice", () => {
  it("is null without a pending refund", () => {
    expect(refundPendingNotice(plan())).toBeNull();
  });

  it("says until when the app can still complete the refund", () => {
    const notice = refundPendingNotice(
      plan({
        refund: {
          amount: "24.90",
          until: "2026-10-31T02:59:59.000Z",
          via: "app",
        },
        refundPending: true,
      } as Partial<BillingPlanView>)
    );
    expect(notice?.title).toBe(
      "Cancelamos a renovação, mas o reembolso não foi concluído."
    );
    expect(notice?.description).toContain("até 30/10/2026, 23:59");
  });

  it("hands the refund to support past 72 hours", () => {
    const notice = refundPendingNotice(
      plan({ refund: null, refundPending: true })
    );
    expect(notice).toEqual({
      description:
        "Nada será cobrado a mais. Você recebe um e-mail quando o reembolso for concluído.",
      title: "Cancelamos a renovação. O reembolso está com o nosso suporte.",
    });
    expect(`${notice?.title} ${notice?.description}`).not.toContain("Tentar");
  });
});

describe("refundRuleLine (AS-14, Emenda 2)", () => {
  const ENDED =
    "O reembolso integral vale nos primeiros 7 dias depois da primeira cobrança. Esse prazo terminou em 17/10/2026.";
  const refund = {
    amount: "24.90",
    until: "2026-10-18T02:59:59.000Z",
    via: "app" as const,
  };
  const pro = {
    accessEndsAt: "2026-11-11T03:00:00.000Z",
    method: "card" as const,
    state: "active" as const,
  };

  it.each([
    // the state × the window × refundPending → the line
    ["Free (the offer)", plan(), REFUND_RULE],
    [
      "Free, still with the date of an old window",
      plan({ refundWindowEndedOn: "2026-10-17" }),
      REFUND_RULE,
    ],
    ["Free over the limit", plan({ state: "free_over_limit" }), REFUND_RULE],
    ["waiting for the method", plan({ state: "trial_setup" }), REFUND_RULE],
    ["trial", plan({ state: "trialing" }), REFUND_RULE],
    ["Pro in the window, card", plan({ ...pro, refund }), REFUND_RULE],
    [
      "Pro in the window, Pix by support",
      plan({ ...pro, refund: { ...refund, via: "suporte" } }),
      REFUND_RULE,
    ],
    [
      "Pro in the window, renewal cancelled",
      plan({ ...pro, refund, renewalCancelled: true }),
      REFUND_RULE,
    ],
    [
      "Pro after the 7th day",
      plan({ ...pro, refundWindowEndedOn: "2026-10-17" }),
      ENDED,
    ],
    [
      "Pro after the renewal",
      plan({
        ...pro,
        accessEndsAt: "2026-12-11T03:00:00.000Z",
        refundWindowEndedOn: "2026-10-17",
      }),
      ENDED,
    ],
    [
      "renewal cancelled, window over",
      plan({
        ...pro,
        refundWindowEndedOn: "2026-10-17",
        renewalCancelled: true,
      }),
      ENDED,
    ],
    ["Pro without any date from the server", plan({ ...pro }), null],
    [
      "Pro read from a Worker of the previous version (no field)",
      { ...plan({ ...pro }), refundWindowEndedOn: undefined } as never,
      null,
    ],
    [
      "refund not completed, in the 72 hours",
      plan({ ...pro, refund, refundPending: true, renewalCancelled: true }),
      null,
    ],
    [
      "refund not completed, with support",
      plan({
        ...pro,
        refundPending: true,
        refundWindowEndedOn: "2026-10-17",
        renewalCancelled: true,
      }),
      null,
    ],
    ["refund not completed, back on Free", plan({ refundPending: true }), null],
    [
      "grace",
      plan({ ...pro, refundWindowEndedOn: "2026-10-17", state: "grace" }),
      null,
    ],
  ])("%s", (_label, value, line) => {
    expect(refundRuleLine(value)).toBe(line);
  });

  it("never says the rule where the screen speaks of the refund asked or of the charge that failed", () => {
    for (const value of [
      plan({ ...pro, refund, refundPending: true }),
      plan({ ...pro, refundPending: true }),
      plan({ ...pro, refund, state: "grace" }),
    ]) {
      expect(refundRuleLine(value) ?? "").not.toContain("Você pode desistir");
      expect(refundRuleLine(value) ?? "").not.toContain("reembolso integral");
    }
  });
});

describe("offerCycles and defaultCycle", () => {
  it("lists monthly first, with the annual bonus and per-month price", () => {
    const [monthly, annual] = offerCycles(plan());
    expect(monthly).toMatchObject({
      bonus: null,
      cycleMonths: 1,
      price: "R$ 24,90",
      unit: "por mês",
    });
    expect(annual).toMatchObject({
      bonus: "2 meses grátis",
      cycleMonths: 12,
      price: "R$ 249,00",
      unit: "por ano · R$ 20,75 por mês",
    });
  });

  it("sorts the prices whatever the input order", () => {
    const cycles = offerCycles(
      plan({
        offer: {
          methods: ["card"],
          prices: [
            { amount: "249.00", cycleMonths: 12 },
            { amount: "24.90", cycleMonths: 1 },
          ],
        },
      })
    );
    expect(cycles.map((cycle) => cycle.cycleMonths)).toEqual([1, 12]);
  });

  it("has no bonus when the saving is under one month", () => {
    const cycles = offerCycles(
      plan({
        offer: {
          methods: ["card"],
          prices: [
            { amount: "24.90", cycleMonths: 1 },
            { amount: "290.00", cycleMonths: 12 },
          ],
        },
      })
    );
    expect(cycles[1]?.bonus).toBeNull();
  });

  it("follows the catalog amount in the text", () => {
    const cycles = offerCycles(
      plan({
        offer: {
          methods: ["card"],
          prices: [{ amount: "29.90", cycleMonths: 1 }],
        },
      })
    );
    expect(cycles[0]?.price).toBe("R$ 29,90");
  });

  it("chooses monthly by default", () => {
    expect(defaultCycle(offerCycles(plan()))).toBe(1);
  });

  it("falls back to the first cycle without a monthly price", () => {
    const cycles = offerCycles(
      plan({
        offer: {
          methods: ["card"],
          prices: [{ amount: "249.00", cycleMonths: 12 }],
        },
      })
    );
    expect(defaultCycle(cycles)).toBe(12);
  });

  it("has no default without prices", () => {
    expect(defaultCycle([])).toBeNull();
  });
});

describe("offerTerms and firstChargeDay", () => {
  it("offers 7 dias grátis on the card", () => {
    expect(
      offerTerms({
        amount: "24.90",
        method: "card",
        now: NOW,
        trialAvailable: true,
      })
    ).toEqual({
      action: "Começar os 7 dias grátis",
      charge:
        "A primeira cobrança, de R$ 24,90, é em 30/10/2026. Cancele antes e nada é cobrado.",
      lead: "7 dias grátis.",
    });
  });

  it("offers a trial without a number of days on Pix", () => {
    const terms = offerTerms({
      amount: "24.90",
      method: "pix_automatic",
      now: NOW,
      trialAvailable: true,
    });
    expect(terms.action).toBe("Começar o teste grátis");
    expect(`${terms.action} ${terms.lead} ${terms.charge}`).not.toContain(
      "7 dias"
    );
  });

  it("charges today when the trial was used", () => {
    expect(
      offerTerms({
        amount: "24.90",
        method: "card",
        now: NOW,
        trialAvailable: false,
      })
    ).toEqual({
      action: "Assinar o Pro",
      charge: "A primeira cobrança, de R$ 24,90, é hoje.",
      lead: "Seu teste grátis já foi usado.",
    });
  });

  it("never says sem cartão", () => {
    for (const method of ["card", "pix_automatic"] as const) {
      for (const trialAvailable of [true, false]) {
        const terms = offerTerms({
          amount: "24.90",
          method,
          now: NOW,
          trialAvailable,
        });
        expect(JSON.stringify(terms).toLowerCase()).not.toContain("sem cartão");
      }
    }
  });

  it("uses the Sao Paulo day for the first charge", () => {
    expect(firstChargeDay(new Date("2026-10-24T02:30:00Z"), true)).toBe(
      "2026-10-30"
    );
  });

  it("is today in Sao Paulo without a trial", () => {
    expect(firstChargeDay(new Date("2026-10-24T02:30:00Z"), false)).toBe(
      "2026-10-23"
    );
  });
});

describe("paymentLines", () => {
  it("is null on free and trial_setup", () => {
    expect(paymentLines(plan())).toBeNull();
    expect(
      paymentLines(plan({ method: "card", state: "trial_setup" }))
    ).toBeNull();
  });

  it("lists method, cycle and next charge when active", () => {
    expect(
      paymentLines(
        plan({
          cycleMonths: 1,
          method: "card",
          nextCharge: { amount: "24.90", on: "2026-11-23" },
          state: "active",
        })
      )
    ).toEqual([
      { label: "Como paga", value: "Cartão de crédito" },
      { label: "Ciclo", value: "Mensal · R$ 24,90" },
      { label: "Próxima cobrança", value: "23/11/2026 · R$ 24,90" },
    ]);
  });

  it("calls it Primeira cobrança while trialing", () => {
    const lines = paymentLines(
      plan({
        cycleMonths: 1,
        method: "card",
        nextCharge: { amount: "24.90", on: "2026-10-30" },
        state: "trialing",
      })
    );
    expect(lines?.[2]).toEqual({
      label: "Primeira cobrança",
      value: "30/10/2026 · R$ 24,90",
    });
  });

  it("says Nenhuma when the renewal is cancelled", () => {
    const lines = paymentLines(
      plan({
        cycleMonths: 1,
        method: "card",
        nextCharge: { amount: "24.90", on: "2026-11-23" },
        renewalCancelled: true,
        state: "active",
      })
    );
    expect(lines?.[2]).toEqual({ label: "Próxima cobrança", value: "Nenhuma" });
  });

  it("shows only method and cycle in grace", () => {
    const lines = paymentLines(
      plan({
        cycleMonths: 1,
        method: "pix_automatic",
        nextCharge: { amount: "24.90", on: "2026-11-23" },
        state: "grace",
      })
    );
    expect(lines).toEqual([
      { label: "Como paga", value: "Pix Automático" },
      { label: "Ciclo", value: "Mensal · R$ 24,90" },
    ]);
  });
});

describe("checkout return", () => {
  it("reads the three returns and ignores anything else", () => {
    expect(checkoutReturnOf("?retorno=concluida")).toBe("concluida");
    expect(checkoutReturnOf("?retorno=cancelada")).toBe("cancelada");
    expect(checkoutReturnOf("?retorno=expirada")).toBe("expirada");
    expect(checkoutReturnOf("?retorno=outra")).toBeNull();
    expect(checkoutReturnOf("")).toBeNull();
  });

  it("moves the legacy return to the Assinatura", () => {
    expect(legacyCheckoutReturnPath("/", "?assinatura=concluida")).toBe(
      "/configuracoes?aba=assinatura&retorno=concluida"
    );
    expect(legacyCheckoutReturnPath("/sales", "?assinatura=concluida")).toBe(
      null
    );
    expect(legacyCheckoutReturnPath("/", "?assinatura=outra")).toBeNull();
  });
});

describe("waitsForProvider and abandonedCheckoutText", () => {
  it("waits on trial_setup", () => {
    expect(waitsForProvider(plan({ state: "trial_setup" }), null)).toBe(true);
  });

  it("waits on free after a completed return only", () => {
    expect(waitsForProvider(plan(), "concluida")).toBe(true);
    expect(waitsForProvider(plan(), null)).toBe(false);
    expect(waitsForProvider(plan({ state: "trialing" }), "concluida")).toBe(
      false
    );
  });

  it("says nothing was charged after an abandoned checkout", () => {
    expect(abandonedCheckoutText("cancelada", plan())).toBe(
      "O pagamento não foi feito e nada foi cobrado. Seu teste grátis continua disponível."
    );
    expect(
      abandonedCheckoutText("cancelada", plan({ trialAvailable: false }))
    ).toBe("O pagamento não foi feito e nada foi cobrado.");
  });

  it("says nothing on trialing or without an abandoned return", () => {
    expect(
      abandonedCheckoutText("cancelada", plan({ state: "trialing" }))
    ).toBeNull();
    expect(abandonedCheckoutText("concluida", plan())).toBeNull();
    expect(abandonedCheckoutText(null, plan())).toBeNull();
  });
});

describe("checkoutRefusal", () => {
  const cases: [string, string, boolean, boolean, string][] = [
    [
      "CONFLICT",
      "already_subscribed",
      true,
      false,
      "Sua loja já tem o Pro. Atualize para ver o plano.",
    ],
    [
      "CONFLICT",
      "checkout_in_progress",
      false,
      true,
      "Outro pedido de assinatura com esse documento está em andamento. Aguarde um instante e tente de novo.",
    ],
    [
      "CONFLICT",
      "checkout_pending_confirmation",
      true,
      false,
      "Seu pagamento anterior ainda está sendo confirmado. Aguarde alguns minutos e atualize antes de começar de novo.",
    ],
    [
      "CONFLICT",
      "cycle_not_offered",
      true,
      false,
      "Esse ciclo não está mais disponível. Atualize e escolha de novo.",
    ],
    [
      "CONFLICT",
      "trial_already_used",
      true,
      false,
      "Seu teste grátis já foi usado. Atualize para assinar sem o teste.",
    ],
    [
      "CONFLICT",
      "trial_in_progress",
      true,
      false,
      "Seu teste grátis já está em andamento em outra loja. O teste vale uma vez por pessoa.",
    ],
    [
      "SERVICE_UNAVAILABLE",
      "billing_provider_unavailable",
      false,
      true,
      "O serviço de pagamento não respondeu. Nada foi cobrado. Tente de novo em alguns minutos.",
    ],
    [
      "SERVICE_UNAVAILABLE",
      "billing_not_configured",
      false,
      false,
      "A assinatura pelo app não está disponível agora. Nada foi cobrado. Tente mais tarde.",
    ],
    [
      "CONFLICT",
      "command_in_progress",
      false,
      true,
      "Já tem um pedido desta loja em andamento. Espere alguns segundos e tente de novo.",
    ],
    [
      "TOO_MANY_REQUESTS",
      "billing_command_rate_limited",
      false,
      true,
      "Muitas tentativas seguidas. Espere um minuto e tente de novo.",
    ],
  ];

  it.each(cases)("%s %s", (code, reason, reread, retry, text) => {
    expect(checkoutRefusal(rpcError(code, reason))).toEqual({
      reread,
      retry,
      text,
    });
  });

  it("says the same for billing_self_service_off as for billing_not_configured", () => {
    expect(
      checkoutRefusal(rpcError("NOT_FOUND", "billing_self_service_off"))
    ).toEqual(
      checkoutRefusal(rpcError("SERVICE_UNAVAILABLE", "billing_not_configured"))
    );
  });

  it("gives each reason its own text, except the shared ones", () => {
    const texts = cases.map(
      ([code, reason]) => checkoutRefusal(rpcError(code, reason)).text
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("says the same for payer_not_accepted whatever the server's message (it never tells whether the document is known)", () => {
    const withMessage = checkoutRefusal(
      rpcError("BAD_REQUEST", "payer_not_accepted", {
        message: "CPF inválido para o Pix.",
      })
    );
    const without = checkoutRefusal(
      rpcError("BAD_REQUEST", "payer_not_accepted")
    );
    expect(withMessage).toEqual(without);
    expect(without.retry).toBe(false);
    expect(without.text).toBe(
      "Não foi possível iniciar o Pix Automático com esses dados. Confira o nome, o CPF ou CNPJ e o e-mail, ou escolha o cartão."
    );
  });

  it("names the date to subscribe again after cancelling", () => {
    expect(
      checkoutRefusal(
        rpcError("CONFLICT", "renewal_cancelled_until", {
          until: "2026-11-24T03:00:00.000Z",
        })
      )
    ).toEqual({
      reread: true,
      retry: false,
      text: "Você cancelou a renovação. Dá para assinar de novo depois de 23/11/2026.",
    });
  });

  it("has a text for renewal_cancelled_until without a date", () => {
    expect(
      checkoutRefusal(rpcError("CONFLICT", "renewal_cancelled_until")).text
    ).toBe(
      "Você cancelou a renovação. Dá para assinar de novo quando o período pago terminar."
    );
  });

  it("allows retry on SERVICE_UNAVAILABLE without a known reason", () => {
    expect(
      checkoutRefusal({ code: "SERVICE_UNAVAILABLE", data: {}, message: "" })
    ).toMatchObject({ reread: false, retry: true });
  });

  it("asks to reread on an unknown CONFLICT", () => {
    expect(checkoutRefusal(rpcError("CONFLICT", "something_new"))).toEqual({
      reread: true,
      retry: false,
      text: "Não foi possível começar a assinatura agora. Atualize e tente de novo.",
    });
  });

  it("recognizes a connection failure and allows retry", () => {
    expect(checkoutRefusal(new TypeError("Failed to fetch"))).toEqual({
      reread: false,
      retry: true,
      text: "A conexão falhou antes da resposta. Nada foi cobrado. Confira a conexão e tente de novo.",
    });
  });
});

describe("readRefusal", () => {
  it("says only the owner can manage the subscription", () => {
    expect(
      readRefusal(rpcError("FORBIDDEN", "billing_manage_required"))
    ).toEqual({
      reread: false,
      retry: false,
      text: "Só o dono da loja pode ver e mudar a assinatura.",
    });
  });

  it("does not retry when the self-service is off", () => {
    const refusal = readRefusal(
      rpcError("NOT_FOUND", "billing_self_service_off")
    );
    expect(refusal.retry).toBe(false);
    expect(refusal.text).toBe("A assinatura não está disponível agora.");
  });

  it("retries anything else", () => {
    expect(readRefusal(new Error("boom"))).toEqual({
      reread: false,
      retry: true,
      text: "O servidor não respondeu. Nada mudou no seu plano.",
    });
  });
});

describe("date helpers", () => {
  it("writes the last second of a window in Sao Paulo", () => {
    expect(untilText("2026-10-31T02:59:59.000Z")).toBe("30/10/2026, 23:59");
  });

  it("writes the last day of an access ending at an instant", () => {
    expect(accessDateText("2026-11-24T03:00:00.000Z")).toBe("23/11/2026");
  });

  it("counts calendar days and never goes negative", () => {
    expect(daysUntil("2026-10-30", "2026-10-23")).toBe(7);
    expect(daysUntil("2026-10-23", "2026-10-30")).toBe(0);
  });
});

describe("the memory of the notice of grace (sessionStorage, by store)", () => {
  const fakeStore = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      values,
    };
  };
  const GRACE_FACTS = {
    accessEndsAt: "2026-10-31T03:00:00.000Z",
    state: "grace",
  } as const;

  it("keeps only the state, the end of the access, the store and when it was read", () => {
    const store = fakeStore();
    rememberPlanNotice("loja-a", GRACE_FACTS, 1000, store);
    expect(JSON.parse(store.values.get(PLAN_NOTICE_KEY) ?? "null")).toEqual({
      accessEndsAt: "2026-10-31T03:00:00.000Z",
      organizationId: "loja-a",
      readAt: 1000,
      state: "grace",
    });
    expect(rememberedPlanNotice("loja-a", store)).toMatchObject(GRACE_FACTS);
  });

  it("never gives one store's plan to another", () => {
    const store = fakeStore();
    rememberPlanNotice("loja-a", GRACE_FACTS, 1000, store);
    expect(rememberedPlanNotice("loja-b", store)).toBeNull();
  });

  it("is read again once it is 5 minutes old, never read, or read 'in the future'", () => {
    expect(planNoticeIsOld(null, 0)).toBe(true);
    expect(planNoticeIsOld({ readAt: 0 }, PLAN_NOTICE_FOR_MS - 1)).toBe(false);
    expect(planNoticeIsOld({ readAt: 0 }, PLAN_NOTICE_FOR_MS)).toBe(true);
    expect(planNoticeIsOld({ readAt: 5000 }, 1000)).toBe(true);
  });

  it("refuses what is not a remembered plan", () => {
    const store = fakeStore();
    for (const value of [
      "not json",
      "42",
      JSON.stringify({ organizationId: "loja-a", readAt: "x", state: "grace" }),
      JSON.stringify({
        accessEndsAt: 1,
        organizationId: "loja-a",
        readAt: 1,
        state: "grace",
      }),
    ]) {
      store.values.set(PLAN_NOTICE_KEY, value);
      expect(rememberedPlanNotice("loja-a", store)).toBeNull();
    }
  });

  it("is dropped when the session ends", () => {
    const store = fakeStore();
    rememberPlanNotice("loja-a", GRACE_FACTS, 1000, store);
    clearPlanNotice(store);
    expect(store.values.has(PLAN_NOTICE_KEY)).toBe(false);
    expect(rememberedPlanNotice("loja-a", store)).toBeNull();
  });
});

describe("usageRows", () => {
  const overOf = (view: BillingPlanView) =>
    Object.fromEntries(usageRows(view).map((row) => [row.id, row.over]));

  it("flags a use above the limit on any plan, the Pro included", () => {
    const pro = plan({
      limits: { goals: 3, images: 5000, variants: 2000 },
      state: "active",
      usage: { goals: 4, images: 5000, variants: 12 },
    });
    // at the limit is not above it
    expect(overOf(pro)).toEqual({
      goals: true,
      images: false,
      variants: false,
    });
    expect(
      overOf(plan({ usage: { goals: 2, images: 12, variants: 62 } }))
    ).toEqual({ goals: true, images: false, variants: true });
  });

  it("never flags a measure without a limit, and keeps its number", () => {
    const view = plan({
      limits: { goals: null, images: 30, variants: null },
      usage: { goals: 9, images: 12, variants: 700 },
    });
    expect(overOf(view)).toEqual({
      goals: false,
      images: false,
      variants: false,
    });
    expect(usageRows(view).find((row) => row.id === "goals")).toMatchObject({
      limit: null,
      used: 9,
    });
  });
});

describe("safeProviderUrl", () => {
  it.each([
    "https://asaas.com/i/abc",
    "https://www.asaas.com/c/abc",
    "https://sandbox.asaas.com/i/abc",
    "https://app.woovi-sandbox.com/pay/e2e",
    "https://woovi.com/pay/x",
    "https://openpix.com.br/pay/x",
  ])("opens %s", (url) => {
    expect(safeProviderUrl(url)).toBe(url);
  });

  it.each([
    "http://asaas.com/i/abc",
    "https://evil.example/i/abc",
    "https://asaas.com.evil.example/i/abc",
    "https://evilasaas.com/i/abc",
    "https://asaas.com@evil.example/i",
    "https://user:pass@asaas.com/i",
    "https://asaas.com:8443/i",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(safeProviderUrl(url)).toBeNull();
  });

  it("refuses no address", () => {
    expect(safeProviderUrl(null)).toBeNull();
  });
});

describe("planNoticeRetryDelayMs", () => {
  it("doubles from 1 min and stops at 10 min", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 20].map((failures) => planNoticeRetryDelayMs(failures))
    ).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  });
});
