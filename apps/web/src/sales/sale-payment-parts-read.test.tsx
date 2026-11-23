import type { ConfirmedSaleReadModel } from "@polaris/contracts";
import { Money } from "@polaris/domain/money/money";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmedSaleView } from "./sale-form-model";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const { SaleReceipt } = await import("./sale-receipt");
const { ConfirmedSalePanel } = await import("./sale-confirmed-panel");

const MONO_AMOUNT =
  /text-right font-mono tabular-nums[^"]*"><span[^>]*>R\$ 100,01</;
const PART_BLOCKS = /data-payment-part="\d"/g;
const TOTAL_CELLS = /data-money-number="">300</g;
const ID = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";

const noFee = {
  amount: "0.00",
  fixedAmount: null,
  mode: "not_applicable",
  percentage: null,
} as const;

const pixPart = {
  amount: "100.01",
  anticipationFee: noFee,
  anticipationRequested: false,
  expectedSettlementDays: 0,
  installmentPlan: null,
  installments: null,
  method: "pix",
  paymentProfileId: PROFILE,
  paymentProfileName: "Maquininha",
  paymentProfileRuleId: PROFILE,
  paymentProfileVersion: 1,
  position: 0,
  processingFee: {
    amount: "0.50",
    fixedAmount: null,
    mode: "percentage",
    percentage: "0.5",
  },
} as const;

const creditPart = {
  amount: "199.99",
  anticipationFee: noFee,
  anticipationRequested: false,
  expectedSettlementDays: 30,
  installmentPlan: "merchant",
  installments: 3,
  method: "credit_card",
  paymentProfileId: null,
  paymentProfileName: null,
  paymentProfileRuleId: null,
  paymentProfileVersion: null,
  position: 1,
  processingFee: {
    amount: null,
    fixedAmount: null,
    mode: "percentage",
    percentage: null,
  },
} as const;

const sale = (
  payments: ConfirmedSaleReadModel["payments"]
): ConfirmedSaleReadModel => {
  const [first] = payments ?? [];
  if (!first) {
    throw new Error("a sale needs a part");
  }
  const total = (payments ?? [])
    .reduce((sum, part) => sum.add(Money.from(part.amount)), Money.from("0"))
    .toString();
  return {
    adjustments: [],
    items: [
      {
        chargedUnitPrice: total,
        listedUnitPrice: total,
        position: 0,
        productId: ID,
        productLabel: "Vela",
        quantity: 1,
        unitCost: null,
        variantId: ID,
      },
    ],
    payment: first,
    payments,
    replayed: false,
    sale: {
      commandId: ID,
      confirmedAt: "2026-05-01T12:00:01.000Z",
      currency: "BRL",
      id: ID,
      occurredAt: "2026-05-01T12:00:00.000Z",
      occurredOn: "2026-05-01",
      recordedAt: null,
    },
    totals: {
      discountTotal: "0.00",
      freightTotal: "0.00",
      paymentSurchargeTotal: "0.00",
      subtotal: total,
      surchargeTotal: "0.00",
      totalDue: total,
    },
  };
};

const twoParts = () => sale([pixPart, creditPart]);

const render = (read: ConfirmedSaleReadModel) =>
  renderToStaticMarkup(
    <SaleReceipt
      sale={confirmedSaleView(read)}
      status={<span>Confirmada</span>}
    />
  );

beforeEach(() => {
  state.hidden = false;
});

describe("the payment of a sale in two parts, in the view", () => {
  it("has one part per position, the amount of each as the server stored it", () => {
    const view = confirmedSaleView(twoParts());
    expect(
      view.paymentParts?.map(({ amountText, methodText, position }) => ({
        amountText,
        methodText,
        position,
      }))
    ).toEqual([
      { amountText: "R$ 100,01", methodText: "Pix", position: 0 },
      {
        amountText: "R$ 199,99",
        methodText: "Cartão de crédito",
        position: 1,
      },
    ]);
  });

  it("makes the amounts of the parts add up to the total due, in cents", () => {
    const read = twoParts();
    const sum = (read.payments ?? []).reduce(
      (total, part) => total.add(Money.from(part.amount)),
      Money.from("0")
    );
    expect(sum.toString()).toBe(read.totals.totalDue);
    expect(confirmedSaleView(read).totals.at(-1)?.value).toBe("R$ 300,00");
  });

  it("writes the installments under the credit part, without inventing the value of an installment", () => {
    const [pix, credit] = confirmedSaleView(twoParts()).paymentParts ?? [];
    expect(pix?.installmentText).toBeNull();
    expect(credit?.installmentText).toBe("3x · Parcelado pelo lojista");
  });

  it("gives each part its own profile, fees and settlement estimate", () => {
    const [pix, credit] = confirmedSaleView(twoParts()).paymentParts ?? [];
    const byLabel = (details: NonNullable<typeof pix>["details"]) =>
      Object.fromEntries(details.map((d) => [d.label, d.value]));
    expect(byLabel(pix?.details ?? [])).toMatchObject({
      "Perfil de pagamento": "Maquininha",
      Prazo: "prazo estimado de 0 dias — estimativa, não data de liquidação",
    });
    expect(byLabel(credit?.details ?? [])).toMatchObject({
      "Perfil de pagamento": "Sem perfil de pagamento",
      "Taxa de processamento": "desconhecida — não é zero",
    });
  });

  it("leaves a sale of one part as it was: no parts, the same block of details", () => {
    const one = confirmedSaleView(sale([pixPart]));
    expect(one.paymentParts).toBeUndefined();
    expect(Object.keys(one)).not.toContain("paymentParts");
    expect(one.paymentDetails.map((detail) => detail.label)).toEqual([
      "Método",
      "Valor do pagamento",
      "Perfil de pagamento",
      "Regra",
      "Taxa de processamento",
      "Taxa de antecipação",
      "Prazo",
    ]);
  });

  it("reads a sale from an older copy, with no list of parts, as one part", () => {
    const { payments: _omitted, ...older } = sale([pixPart]);
    expect(confirmedSaleView(older).paymentParts).toBeUndefined();
  });
});

describe("the receipt of a sale in two parts", () => {
  it("names the block 'Pagamento em 2 partes' and lists the parts in order", () => {
    const markup = render(twoParts());
    expect(markup).toContain('aria-label="Pagamento em 2 partes"');
    const order = [
      "Pagamento em 2 partes",
      "Parte 1: ",
      "Pix",
      "R$ 100,01",
      "Parte 2: ",
      "Cartão de crédito",
      "R$ 199,99",
    ];
    let cursor = markup.indexOf("Pagamento em 2 partes");
    for (const text of order) {
      const at = markup.indexOf(text, cursor);
      expect(at, text).toBeGreaterThanOrEqual(cursor);
      cursor = at;
    }
  });

  it("writes the amount of each part in mono at the right and has no line with the sum", () => {
    const markup = render(twoParts());
    expect(markup).toMatch(MONO_AMOUNT);
    expect(markup).not.toContain("Valor do pagamento");
    expect(markup.match(TOTAL_CELLS)).toHaveLength(1);
  });

  it("writes the installments of the credit part on the line below it", () => {
    const markup = render(twoParts());
    expect(markup).toContain("3x · Parcelado pelo lojista");
    expect(markup.indexOf("Cartão de crédito")).toBeLessThan(
      markup.indexOf("3x · Parcelado pelo lojista")
    );
  });

  it("masks the amount of each part with the values hidden", () => {
    state.hidden = true;
    const markup = render(twoParts());
    expect(markup).not.toContain(">100<");
    expect(markup).not.toContain(">199<");
  });

  it("keeps a sale of one part on the block of today, with no group of parts", () => {
    const markup = render(sale([pixPart]));
    expect(markup).not.toContain("Pagamento em");
    expect(markup).toContain('data-receipt-block="payment"');
    expect(markup).toContain("Valor do pagamento");
  });
});

describe("the summary right after confirming a sale in two parts", () => {
  const panel = (read: ConfirmedSaleReadModel) =>
    renderToStaticMarkup(
      <ConfirmedSalePanel
        firstSale={false}
        organizationId="loja-a"
        panelRef={createRef()}
        sale={confirmedSaleView(read)}
      />
    );

  it("lists one block per part with the profile, fees and settlement of each", () => {
    const html = panel(twoParts());
    expect(html).toContain('aria-label="Pagamento em 2 partes"');
    expect(html.match(PART_BLOCKS)).toHaveLength(2);
    expect(html).toContain("R$ 100,01");
    expect(html).toContain("R$ 199,99");
    expect(html).toContain("3x · Parcelado pelo lojista");
    expect(html).toContain("Maquininha");
    expect(html).toContain("desconhecida — não é zero");
  });

  it("keeps the block of today for a sale of one part", () => {
    const html = panel(sale([pixPart]));
    expect(html).not.toContain("Pagamento em");
    expect(html).toContain("Valor do pagamento");
  });
});
