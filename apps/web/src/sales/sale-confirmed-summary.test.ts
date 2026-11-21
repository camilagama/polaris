import type { ConfirmedSaleReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import { confirmedSaleView } from "./sale-form-model";

const ID = "11111111-1111-4111-8111-111111111111";

const item = (position: number, quantity: number) => ({
  chargedUnitPrice: "10.00",
  listedUnitPrice: "10.00",
  position,
  productId: ID,
  productLabel: `Produto ${position}`,
  quantity,
  unitCost: null,
  variantId: ID,
});

const fee = {
  amount: "0.00",
  fixedAmount: null,
  mode: "not_applicable",
  percentage: null,
} as const;

const sale = (
  quantities: number[],
  amount: string,
  totals: { subtotal: string; totalDue: string } = {
    subtotal: amount,
    totalDue: amount,
  }
): ConfirmedSaleReadModel => ({
  adjustments: [],
  items: quantities.map((quantity, position) => item(position, quantity)),
  payment: {
    amount,
    anticipationFee: fee,
    anticipationRequested: false,
    expectedSettlementDays: null,
    installmentPlan: null,
    installments: null,
    method: "pix",
    paymentProfileId: null,
    paymentProfileName: null,
    paymentProfileRuleId: null,
    paymentProfileVersion: null,
    processingFee: fee,
  },
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
    subtotal: totals.subtotal,
    surchargeTotal: "0.00",
    totalDue: totals.totalDue,
  },
});

describe("the figures beside the total of the receipt", () => {
  it("sums the quantities of every line and writes what the sale stored as received", () => {
    const view = confirmedSaleView(sale([2, 3, 1], "60.00"));
    expect(view.summary).toEqual({ itemCount: 6, received: "R$ 60,00" });
  });

  it("counts the quantities, not the lines, and keeps the thousands", () => {
    const view = confirmedSaleView(sale([1200], "12000.50"));
    expect(view.summary.itemCount).toBe(1200);
    expect(view.summary.received).toBe("R$ 12.000,50");
  });

  it("reads the received amount from the stored payment, not from the total or the subtotal", () => {
    const view = confirmedSaleView(
      sale([4, 5], "88.82", { subtotal: "99.80", totalDue: "90.00" })
    );
    expect(view.summary.received).toBe("R$ 88,82");
    expect(view.totals.find((row) => row.tone === "total")?.value).toBe(
      "R$ 90,00"
    );
  });

  it("agrees with the lines the receipt shows: the payment line and the count of the items", () => {
    const view = confirmedSaleView(sale([4, 5], "90.00"));
    expect(view.items).toHaveLength(2);
    const paid = view.paymentDetails.find(
      (detail) => detail.label === "Valor do pagamento"
    );
    expect(view.summary.received).toBe(paid?.value);
    expect(view.summary.itemCount).toBe(9);
  });
});
