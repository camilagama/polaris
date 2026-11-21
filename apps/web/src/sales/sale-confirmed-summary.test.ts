import type { ConfirmedSaleReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import { confirmedSaleView } from "./sale-form-model";
import {
  historyLoaded,
  historyRows,
  initialHistoryState,
} from "./sale-history-model";

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
  amount: string
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
    subtotal: amount,
    surchargeTotal: "0.00",
    totalDue: amount,
  },
});

describe("the figure beside the total of the receipt", () => {
  it("counts the lines of the sale, not the sum of their quantities", () => {
    const view = confirmedSaleView(sale([2, 3, 1], "60.00"));
    expect(view.summary).toEqual({ itemCount: 3 });
  });

  it("counts one line of quantity 1200 as one", () => {
    const view = confirmedSaleView(sale([1200], "12000.50"));
    expect(view.summary.itemCount).toBe(1);
  });

  it("agrees with the lines the receipt shows, and does not claim what was received", () => {
    const view = confirmedSaleView(sale([4, 5], "90.00"));
    expect(view.items).toHaveLength(2);
    expect(view.summary.itemCount).toBe(2);
    expect(Object.keys(view.summary)).toEqual(["itemCount"]);
  });

  it("shows the same number as the history row of the same sale: one line of quantity 2 is 1", () => {
    const detail = confirmedSaleView(sale([2], "20.00"));
    const [row] = historyRows(
      historyLoaded(
        initialHistoryState(),
        {
          hasMore: false,
          sales: [
            {
              cancelledAt: null,
              confirmedAt: "2026-05-01T12:00:01.000Z",
              customerId: null,
              customerName: null,
              hasReturns: false,
              id: ID,
              itemCount: 1,
              occurredAt: "2026-05-01T12:00:00.000Z",
              occurredOn: "2026-05-01",
              paymentMethod: "pix",
              status: "confirmed",
              totalDue: "20.00",
            },
          ],
        },
        "filtro-a"
      )
    );
    expect(detail.summary.itemCount).toBe(1);
    expect(row?.itemCountText).toBe(`${detail.summary.itemCount} item`);
  });
});
